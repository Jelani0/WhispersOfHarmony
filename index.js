/**
 * =====================================================================
 * == Cloud Functions for Whispers of Harmony - The Backend Engine  ==
 * =====================================================================
 *
 * V12.1 - Refactored & Resilient AI.
 * This version corrects all AI client implementation errors, ensuring
 * consistent and reliable calls to Vertex AI. It also heavily optimizes

 * the AI User Initialization process for speed and cost-savings.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { VertexAI } = require('@google-cloud/vertexai');
const stripe = require("stripe");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { getStorage } = require("firebase-admin/storage");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { getMessaging } = require("firebase-admin/messaging");
const functions = require("firebase-functions"); // Make sure functions is required
const getRawBody = require('raw-body');

// --- INITIALIZATION ---
initializeApp();
const db = getFirestore();

const appId = "whispers-of-harmony";

// Lazy initializer for clients
let stripeClient;
let vertex_ai;

let ownerAccountId = "PRG4f2BypPSBWyjAUqhlNa1mPAF2";
const getOwnerAccountId = async () => {
    if (ownerAccountId) return ownerAccountId;

    const ownerEmail = "Jelanichandler1@gmail.com"; // Your unique owner email
    try {
        const ownerQuery = await db.collection(`artifacts/${appId}/public/data/user_profiles`).where("email", "==", ownerEmail).limit(1).get();
        if (ownerQuery.empty) {
            console.error("CRITICAL ECONOMIC ERROR: The owner account could not be found. Fees cannot be collected.");
            return null;
        }
        ownerAccountId = ownerQuery.docs[0].id;
        return ownerAccountId;
    } catch (error) {
        console.error("Error fetching owner account ID:", error);
        return "PRG4f2BypPSBWyjAUqhlNa1mPAF2";
    }
};
/**
 * A reusable, atomic helper function for handling all user-to-platform token transactions.
 * @param {FirebaseFirestore.Transaction} transaction The Firestore transaction object.
 * @param {string} userId The ID of the user spending tokens.
 * @param {number} baseCost The base cost of the action.
 * @param {object} updates An object of additional updates to apply to the user's profile (e.g., quest progress).
 * @returns {Promise<number>} The final cost after applying any discounts.
 */
const _handleEconomicTransaction = async (transaction, userId, baseCost, updates = {}) => {
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const userDoc = await transaction.get(userProfileRef);

    if (!userDoc.exists) {
        throw new HttpsError("not-found", "Your user profile could not be found.");
    }

    const userData = userDoc.data();
    let finalCost = baseCost;
    if (userData.proStatus === 'active') {
        finalCost = Math.ceil(baseCost * 0.5); // 50% discount for Pro members
    }

    if ((userData.tokens || 0) < finalCost) {
        throw new HttpsError("resource-exhausted", `You need ${finalCost} Echoes for this action.`);
    }

    const ownerId = await getOwnerAccountId();
    if (ownerId) {
        const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
        transaction.update(ownerRef, { tokens: FieldValue.increment(finalCost) });
    }

    transaction.update(userProfileRef, {
        tokens: FieldValue.increment(-finalCost),
        ...updates
    });

    return finalCost;
};

const questDefinitions = {
    // Onboarding (Renamed from milestone for clarity)
    'post_first_whisper': { reward: 25, type: 'onboarding' },
    'customize_profile': { reward: 20, type: 'onboarding' },
    'like_three_whispers': { reward: 10, type: 'onboarding' },
    'follow_a_user': { reward: 10, type: 'onboarding' },
    'seal_first_whisper': { reward: 25, type: 'onboarding' },
    'echo_first_whisper': { reward: 20, type: 'onboarding' },
    'join_a_nexus': { reward: 15, type: 'onboarding' },

    // Daily
    'daily_login': { reward: 10, type: 'daily' },
    'amplify_whisper_daily': { reward: 15, type: 'daily' },
    'add_star_daily': { reward: 10, type: 'daily' },
    'post_whisper_daily': { reward: 5, type: 'daily' },
    'send_three_messages_daily': { reward: 10, type: 'daily' },
    'open_echo_chamber_daily': { reward: 5, type: 'daily' },
    'react_to_five_comments_daily': { reward: 10, type: 'daily' },
    'generate_ai_prompt_daily': { reward: 5, type: 'daily' },
    'complete_three_daily_quests': { reward: 20, type: 'daily_meta' },

    // Weekly
    'post_three_whispers_weekly': { reward: 30, type: 'weekly' },
    'receive_five_amplifications_weekly': { reward: 40, type: 'weekly' },
    'connect_with_three_users_weekly': { reward: 25, type: 'weekly' },
    'spend_100_echoes_weekly': { reward: 30, type: 'weekly' },
    'earn_50_reputation_weekly': { reward: 40, type: 'weekly' },
    'start_constellation_weekly': { reward: 20, type: 'weekly' },
    'get_harmony_sync_weekly': { reward: 25, type: 'weekly' },
    'complete_three_weekly_quests': { reward: 50, type: 'weekly_meta' },

    // Monthly
    'monthly_pro_subscriber': { reward: 500, type: 'monthly' },
    'post_20_whispers_monthly': { reward: 100, type: 'monthly' },
    'maintain_positive_vibe_monthly': { reward: 75, type: 'monthly' },
    'amplify_10_whispers_monthly': { reward: 80, type: 'monthly' },

    // Annual
    'annual_harmony_champion': { reward: 10000, type: 'annual', unique: true }, // Grand prize

    // Milestones
    'reach_100_reputation': { reward: 50, type: 'milestone' },
    'reach_500_reputation': { reward: 100, type: 'milestone' },
    'reach_1000_reputation': { reward: 250, type: 'milestone' },
};



// In index.js
const functionOptions = {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    secrets: ["GEMINI_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEWS_API_KEY", "IFRAMELY_API_KEY", "APILIX_APP_KEY", "APILIX_API_KEY"],
};

// --- LAZY INITIALIZERS ---
const getStripeClient = () => {
    if (!stripeClient) {
        stripeClient = new stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" });
    }
    return stripeClient;
};

const getVertexAIClient = () => {
    if (!vertex_ai) {
        vertex_ai = new VertexAI({
            project: process.env.GCLOUD_PROJECT,
            location: "us-central1"
        });
    }
    return vertex_ai;
};


// In index.js, REPLACE the getEchoesOfTomorrow function with this one.
exports.getEchoesOfTomorrow = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const userId = request.auth.uid;
    const TOKEN_COST = 20;

    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const q = whispersRef.where("authorId", "==", userId).orderBy("timestamp", "desc").limit(15);
    const snapshot = await q.get();
    if (snapshot.docs.length < 3) throw new HttpsError("failed-precondition", "You need at least 3 whispers to generate a personalized prompt.");

    const whispersText = snapshot.docs.map(doc => doc.data().content).join("\n---\n");
    const prompt = `Analyze the user's recent journal entries. Based on recurring themes, generate a single, insightful, and forward-looking question to inspire their next entry. The question should be personal and encouraging. Writings: "${whispersText}"`;

    const { text: promptText } = await generateAiContent(prompt);
    if (!promptText) throw new HttpsError("internal", "The AI failed to generate a prompt. You have not been charged.");

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const ownerId = await getOwnerAccountId();
    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "Your profile could not be found.");
            if ((userDoc.data().tokens || 0) < TOKEN_COST) throw new HttpsError("resource-exhausted", `You need ${TOKEN_COST} Echoes.`);
            transaction.update(userProfileRef, { tokens: FieldValue.increment(-TOKEN_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(TOKEN_COST) });
            }
        });
        return { prompt: promptText };
    } catch (error) {
        console.error(`Error in getEchoesOfTomorrow transaction for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An error occurred while processing your payment.");
    }
});
// In index.js, add this entire new function.
exports.getMyMoments = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to view your Moments.");
    }
    const userId = request.auth.uid;

    try {
        const momentsQuery = db.collection(`artifacts/${appId}/public/data/anonymous_entries`)
            .where("authorId", "==", userId)
            .where("mediaType", "==", "video")
            .orderBy("timestamp", "desc")
            .limit(50); // Limit to a reasonable number for performance

        const snapshot = await momentsQuery.get();

        const moments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        return { moments: moments };

    } catch (error) {
        console.error(`Error fetching Moments for user ${userId}:`, error);
        throw new HttpsError("internal", "Could not fetch your Moments at this time.");
    }
});

exports.propagateProfileUpdate = onDocumentWritten(`artifacts/${appId}/public/data/user_profiles/{userId}`, async (event) => {
    // We only care about updates, not creations or deletions.
    if (!event.data.before.exists || !event.data.after.exists) {
        return null;
    }

    const before = event.data.before.data();
    const after = event.data.after.data();
    const userId = event.params.userId;

    const nameChanged = before.displayName !== after.displayName;
    const photoChanged = before.photoURL !== after.photoURL;

    // If the relevant fields haven't changed, do nothing.
    if (!nameChanged && !photoChanged) {
        return null;
    }

    console.log(`Propagating updates for user ${userId}. Name changed: ${nameChanged}, Photo changed: ${photoChanged}`);

    const updatePayload = {};
    if (nameChanged) updatePayload.authorName = after.displayName;
    if (photoChanged) updatePayload.authorPhotoURL = after.photoURL;

    const batch = db.batch();
    let updatesCount = 0;

    try {
        // 1. Update de-anonymized whispers
        const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
        const whispersQuery = whispersRef.where("authorId", "==", userId).where("isAnonymous", "==", false);
        const whispersSnapshot = await whispersQuery.get();
        whispersSnapshot.forEach(doc => {
            batch.update(doc.ref, updatePayload);
            updatesCount++;
        });

        // 2. Update Nexus Posts (using a collection group query for efficiency)
        const nexusPostsQuery = db.collectionGroup('posts').where('authorId', '==', userId).where('isAnonymous', '==', false);
        const nexusPostsSnapshot = await nexusPostsQuery.get();
        nexusPostsSnapshot.forEach(doc => {
            batch.update(doc.ref, updatePayload);
            updatesCount++;
        });

        if (updatesCount > 0) {
            await batch.commit();
            console.log(`Successfully propagated profile updates to ${updatesCount} documents for user ${userId}.`);
        } else {
            console.log(`No documents required propagation for user ${userId}.`);
        }

        return null;
    } catch (error) {
        console.error(`Error propagating profile updates for user ${userId}:`, error);
        return null;
    }
});

const generateAiContent = async (prompt, safetySettings = []) => {
    try {
        const vertex = getVertexAIClient();
        const model = vertex.getGenerativeModel({
            model: 'gemini-2.5-flash',
            safetySettings: Array.isArray(safetySettings) && safetySettings.length > 0 ? safetySettings : undefined,
        });
        const resp = await model.generateContent(prompt);
        const feedback = resp.response?.promptFeedback;
        const isBlocked = feedback?.blockReason === 'SAFETY';

        if (isBlocked) {
            return {
                text: null,
                flagged: true,
                safetyRatings: feedback.safetyRatings || []
            };
        }

        const content = resp.response?.candidates?.[0]?.content?.parts?.[0]?.text;
        return {
            text: content || null,
            flagged: false,
            safetyRatings: feedback?.safetyRatings || []
        };
    } catch (error) {
        console.error("Error during AI content generation:", error);
        // Check if it's a safety-related API error
        if (error.message && error.message.includes('safety policy')) {
            return { text: null, flagged: true, safetyRatings: [] };
        }
        throw new HttpsError("internal", `AI generation failed: ${error.message}`);
    }
};

// --- THIS IS THE FIX (Part 1): New Internal Helper Function ---
// This helper contains the core moderation logic and can be called by any other function.
const _moderateContentHelper = async (text) => {
    if (!text) {
        return { flagged: false, safetyRatings: [] };
    }
    // A prompt that forces the model to process the text.
    // We aren't interested in the output, only in the safety feedback.
    const prompt = `Can you give this a Gemini Safety feedback? For example "HARM_CATEGORY_HARASSMENT"(ALL OUTPUTS MUST BE IN THAT EXACT FORMAT): "${text}"`;

    const safetySettings = [
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ];

    const result = await generateAiContent(prompt, safetySettings);
    return { flagged: result.flagged, safetyRatings: result.safetyRatings };
};
// In index.js, add this entire new function.
// In index.js, add this entire new function.

exports.saveFcmToken = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }
    const { token } = request.data;
    const userId = request.auth.uid;

    if (!token) {
        throw new HttpsError("invalid-argument", "A valid FCM token is required.");
    }

    // Store the token in a private subcollection for security.
    // Using the token as the document ID automatically handles duplicates.
    const tokenRef = db.doc(`artifacts/${appId}/users/${userId}/private_tokens/${token}`);

    try {
        await tokenRef.set({
            userId: userId,
            createdAt: FieldValue.serverTimestamp()
        });
        return { success: true, message: "FCM token saved successfully." };
    } catch (error) {
        console.error(`Error saving FCM token for user ${userId}:`, error);
        throw new HttpsError("internal", "Could not save the FCM token.");
    }
});

// In index.js, add this new function.
exports.resetMonthlyQuestProgress = onSchedule({ ...functionOptions, schedule: "first day of month 00:00", timeZone: "America/New_York" }, async (event) => {
    const usersRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);
    const snapshot = await usersRef.where("isAI", "==", false).get();
    if (snapshot.empty) return null;

    const batch = db.batch();
    const monthlyResetFields = {
        "monthlyQuestProgress.posts": 0,
        "monthlyQuestProgress.amplifies": 0,
    };
    snapshot.forEach(doc => batch.update(doc.ref, monthlyResetFields));
    await batch.commit();
    console.log(`Reset monthly quest progress for ${snapshot.size} users.`);
});
// In index.js, add this new trigger.
exports.onMessageSent = onDocumentWritten(`artifacts/${appId}/private_chats/{chatId}/messages/{messageId}`, async (event) => {
    if (!event.data.after.exists || event.data.before.exists) return null;
    const message = event.data.after.data();
    if (message.from === 'system') return null;

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${message.from}`);
    return userProfileRef.update({ "dailyQuestProgress.messagesSent": FieldValue.increment(1) });
});

// In index.js, add this entire new function.
exports.notifyOnLike = onDocumentWritten(`artifacts/${appId}/public/data/anonymous_entries/{entryId}`, async (event) => {
    // 1. Only run on update, not creation or deletion.
    if (!event.data.before.exists || !event.data.after.exists) return null;

    const before = event.data.before.data();
    const after = event.data.after.data();

    // 2. Check if a "like" was added.
    const beforeLikes = before.likes || [];
    const afterLikes = after.likes || [];
    if (afterLikes.length <= beforeLikes.length) return null;

    // 3. Identify the new liker.
    const newLikerId = afterLikes.find(id => !beforeLikes.includes(id));
    const authorId = after.authorId;

    // 4. Do not notify if the author liked their own post or if the liker isn't found.
    if (!newLikerId || newLikerId === authorId) return null;

    const entryId = event.params.entryId;

    try {
        const likerSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${newLikerId}`).get();
        const likerName = likerSnap.exists() ? likerSnap.data().displayName : 'Someone';
        const batch = db.batch();
        const contentPreview = after.content.substring(0, 50);

        // A. Create Toast Notification
        const toastRef = db.collection(`artifacts/${appId}/users/${authorId}/toast_notifications`).doc();
        batch.set(toastRef, {
            type: 'LIKE',
            fromUserName: likerName,
            fromUserId: newLikerId,
            message: `liked your whisper: "${contentPreview}..."`,
            timestamp: FieldValue.serverTimestamp(),
            navigation: { page: 'anonymousFeed', params: { scrollToEntry: entryId } },
        });

        // B. Create/Update Condensed List Notification
        const listNotificationRef = db.doc(`artifacts/${appId}/users/${authorId}/notifications/like_${entryId}`);
        const listNotificationSnap = await listNotificationRef.get();

        if (listNotificationSnap.exists()) {
            batch.update(listNotificationRef, {
                message: `and ${listNotificationSnap.data().count || 1} others liked your whisper.`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                count: FieldValue.increment(1)
            });
        } else {
            batch.set(listNotificationRef, {
                type: 'LIKE',
                fromUserName: likerName,
                fromUserId: newLikerId,
                message: `liked your whisper: "${contentPreview}..."`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                navigation: { page: 'anonymousFeed', params: { scrollToEntry: entryId } },
                count: 1,
            });
        }
        await batch.commit();
    } catch (error) {
        console.error(`Error in notifyOnLike for entry ${entryId}:`, error);
    }
    return null;
});
// In index.js, add this entire new scheduled function.
exports.reconcileNexusMemberCounts = onSchedule({ ...functionOptions, schedule: "every 24 hours", timeZone: "America/New_York" }, async (event) => {
    console.log("Running scheduled job: Reconcile Nexus Member Counts");
    const nexusesRef = db.collection(`artifacts/${appId}/public/data/nexuses`);

    try {
        const snapshot = await nexusesRef.get();
        if (snapshot.empty) {
            console.log("No nexuses found to reconcile.");
            return null;
        }

        const batch = db.batch();
        let mismatches = 0;

        for (const nexusDoc of snapshot.docs) {
            const nexusData = nexusDoc.data();
            const storedCount = nexusData.memberCount || 0;
            const trueCount = nexusData.memberIds?.length || 0;

            if (storedCount !== trueCount) {
                mismatches++;
                console.log(`Fixing count for Nexus ${nexusDoc.id}. Stored: ${storedCount}, True: ${trueCount}`);
                batch.update(nexusDoc.ref, { memberCount: trueCount });
            }
        }

        if (mismatches > 0) {
            await batch.commit();
            console.log(`Successfully reconciled member counts for ${mismatches} nexuses.`);
        } else {
            console.log("All Nexus member counts are accurate. No changes needed.");
        }
        return null;

    } catch (error) {
        console.error("CRITICAL ERROR during reconcileNexusMemberCounts job:", error);
        return null;
    }
});

// In index.js, add these three new functions.

exports.notifyOnNewComment = onDocumentWritten(`artifacts/${appId}/public/data/anonymous_entries/{entryId}/comments/{commentId}`, async (event) => {
    if (!event.data.after.exists || event.data.before.exists) return null;
    const commentData = event.data.after.data();
    const whisperRef = event.data.after.ref.parent.parent;
    const whisperSnap = await whisperRef.get();
    if (!whisperSnap.exists) return null;

    const whisperData = whisperSnap.data();
    const authorId = whisperData.authorId;
    const commenterId = commentData.authorId;
    const entryId = whisperRef.id;

    // Don't notify on self-comments
    if (authorId === commenterId) return null;

    try {
        const commenterSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${commenterId}`).get();
        const commenterName = commenterSnap.exists() ? commenterSnap.data().displayName : 'Someone';
        const contentPreview = commentData.content.substring(0, 50);
        const batch = db.batch();

        // 1. Create Toast Notification
        const toastRef = db.collection(`artifacts/${appId}/users/${authorId}/toast_notifications`).doc();
        batch.set(toastRef, {
            type: 'COMMENT',
            fromUserName: commenterName,
            fromUserId: commenterId,
            message: `commented on your whisper: "${contentPreview}..."`,
            timestamp: FieldValue.serverTimestamp(),
            navigation: { page: 'anonymousFeed', params: { scrollToEntry: entryId } },
        });

        // 2. Create/Update Condensed List Notification
        const listNotificationRef = db.doc(`artifacts/${appId}/users/${authorId}/notifications/comment_${entryId}`);
        const listNotificationSnap = await listNotificationRef.get();

        if (listNotificationSnap.exists()) {
            batch.update(listNotificationRef, {
                message: `and ${listNotificationSnap.data().count || 1} others commented on your whisper.`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                count: FieldValue.increment(1)
            });
        } else {
            batch.set(listNotificationRef, {
                type: 'COMMENT',
                fromUserName: commenterName,
                fromUserId: commenterId,
                message: `commented on your whisper: "${contentPreview}..."`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                navigation: { page: 'anonymousFeed', params: { scrollToEntry: entryId } },
                count: 1,
            });
        }
        await batch.commit();
    } catch (error) {
        console.error(`Error in notifyOnNewComment for entry ${entryId}:`, error);
    }
    return null;
});

exports.notifyOnAmplify = onDocumentWritten(`artifacts/${appId}/public/data/anonymous_entries/{entryId}`, async (event) => {
    if (!event.data.after.exists || !event.data.before.exists) return null;
    const before = event.data.before.data();
    const after = event.data.after.data();
    const authorId = after.authorId;

    if ((after.echoesInvested || 0) <= (before.echoesInvested || 0)) return null;

    const oldAmplifiers = Object.keys(before.amplifiers || {});
    const newAmplifiers = Object.keys(after.amplifiers || {});
    const amplifierId = newAmplifiers.find(id => !oldAmplifiers.includes(id));
    if (!amplifierId || authorId === amplifierId) return null;

    const entryId = event.params.entryId;

    try {
        const amplifierSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${amplifierId}`).get();
        const amplifierName = amplifierSnap.exists() ? amplifierSnap.data().displayName : 'Someone';
        const amount = after.amplifiers[amplifierId] - (before.amplifiers?.[amplifierId] || 0);
        const batch = db.batch();

        // 1. Create Toast Notification
        const toastRef = db.collection(`artifacts/${appId}/users/${authorId}/toast_notifications`).doc();
        batch.set(toastRef, {
            type: 'AMPLIFY',
            fromUserName: amplifierName,
            fromUserId: amplifierId,
            message: `amplified your whisper with ${amount} Echoes!`,
            timestamp: FieldValue.serverTimestamp(),
            navigation: { page: 'anonymousFeed', params: { scrollToEntry: entryId } },
        });

        // 2. Create/Update Condensed List Notification
        const listNotificationRef = db.doc(`artifacts/${appId}/users/${authorId}/notifications/amplify_${entryId}`);
        const listNotificationSnap = await listNotificationRef.get();

        if (listNotificationSnap.exists()) {
            batch.update(listNotificationRef, {
                message: `and ${listNotificationSnap.data().count || 1} others amplified your whisper.`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                count: FieldValue.increment(1)
            });
        } else {
            batch.set(listNotificationRef, {
                type: 'AMPLIFY',
                fromUserName: amplifierName,
                fromUserId: amplifierId,
                message: `amplified your whisper with ${amount} Echoes!`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                navigation: { page: 'anonymousFeed', params: { scrollToEntry: entryId } },
                count: 1,
            });
        }
        await batch.commit();
    } catch (error) {
        console.error(`Error in notifyOnAmplify for entry ${entryId}:`, error);
    }
    return null;
});

exports.notifyOnQuestComplete = onDocumentWritten(`artifacts/${appId}/public/data/user_profiles/{userId}`, async (event) => {
    if (!event.data.after.exists || !event.data.before.exists) return null;
    const beforeQuests = Object.keys(event.data.before.data().completedQuests || {});
    const afterQuests = Object.keys(event.data.after.data().completedQuests || {});
    const userId = event.params.userId;

    const newQuestId = afterQuests.find(id => !beforeQuests.includes(id));
    if (!newQuestId) return null;

    const quest = questDefinitions[newQuestId];
    if (!quest) return null;

    try {
        const batch = db.batch();
        const message = `Quest Complete: ${quest.title || newQuestId}! You earned ${quest.reward} Echoes.`;
        const navigation = { page: 'walletHub', params: { tab: 'quests' } };

        // 1. Create Toast Notification
        const toastRef = db.collection(`artifacts/${appId}/users/${userId}/toast_notifications`).doc();
        batch.set(toastRef, {
            type: 'QUEST_COMPLETE', fromUserName: 'System', fromUserId: 'system',
            message: message, timestamp: FieldValue.serverTimestamp(), navigation: navigation,
        });

        // 2. Create List Notification (non-condensing)
        const listNotificationRef = db.collection(`artifacts/${appId}/users/${userId}/notifications`).doc();
        batch.set(listNotificationRef, {
            type: 'QUEST_COMPLETE', fromUserName: 'System',
            message: message, reward: quest.reward, navigation: navigation,
            timestamp: FieldValue.serverTimestamp(), read: false,
        });
        await batch.commit();
    } catch (error) {
        console.error(`Error in notifyOnQuestComplete for user ${userId}:`, error);
    }
    return null;
});
// In index.js, add this entire new function.
exports.notifyOnConstellationGrowth = onDocumentWritten(`artifacts/${appId}/public/data/anonymous_entries/{entryId}`, async (event) => {
    // 1. Only run on creation of a new whisper.
    if (event.data.before.exists || !event.data.after.exists) return null;

    const starData = event.data.after.data();

    // 2. Check if this new whisper is a "star" in a constellation.
    if (starData.isSeed || !starData.constellationId) return null;

    const constellationId = starData.constellationId;
    const starAuthorId = starData.authorId;

    try {
        // 3. Fetch the original "seed" whisper to find its author.
        const seedWhisperSnap = await db.doc(`artifacts/${appId}/public/data/anonymous_entries/${constellationId}`).get();
        if (!seedWhisperSnap.exists) return null;

        const seedAuthorId = seedWhisperSnap.data().authorId;

        // 4. Do not notify if the author is adding a star to their own constellation.
        if (starAuthorId === seedAuthorId) return null;

        const starAuthorSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${starAuthorId}`).get();
        const starAuthorName = starAuthorSnap.exists() ? starAuthorSnap.data().displayName : 'Someone';
        const batch = db.batch();
        const contentPreview = seedWhisperSnap.data().content.substring(0, 50);

        // A. Create Toast Notification
        const toastRef = db.collection(`artifacts/${appId}/users/${seedAuthorId}/toast_notifications`).doc();
        batch.set(toastRef, {
            type: 'CONSTELLATION_GROWTH',
            fromUserName: starAuthorName,
            fromUserId: starAuthorId,
            message: `added a new star to your constellation, "${contentPreview}..."`,
            timestamp: FieldValue.serverTimestamp(),
            navigation: { page: 'anonymousFeed', params: { scrollToEntry: constellationId } },
        });

        // B. Create/Update Condensed List Notification
        const listNotificationRef = db.doc(`artifacts/${appId}/users/${seedAuthorId}/notifications/constellation_${constellationId}`);
        const listNotificationSnap = await listNotificationRef.get();

        if (listNotificationSnap.exists()) {
            batch.update(listNotificationRef, {
                message: `and ${listNotificationSnap.data().count || 1} others added to your constellation.`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                count: FieldValue.increment(1)
            });
        } else {
            batch.set(listNotificationRef, {
                type: 'CONSTELLATION_GROWTH',
                fromUserName: starAuthorName,
                fromUserId: starAuthorId,
                message: `added a new star to your constellation, "${contentPreview}..."`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                navigation: { page: 'anonymousFeed', params: { scrollToEntry: constellationId } },
                count: 1,
            });
        }
        await batch.commit();
    } catch (error) {
        console.error(`Error in notifyOnConstellationGrowth for constellation ${constellationId}:`, error);
    }
    return null;
});

// In index.js, add this entire new function for creating Nexus-specific AI personas.
exports.createNexusPersona = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Authentication is required.");

    const { nexusId, name, bio_prompt, avatar_prompt, interests_list } = request.data;
    const callerId = request.auth.uid;
    const PERSONA_CREATION_COST = 250;

    if (!nexusId || !name || !bio_prompt || !interests_list) {
        throw new HttpsError("invalid-argument", "Nexus ID, name, bio prompt, and interests are required.");
    }

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${callerId}`);
    const ownerId = await getOwnerAccountId();

    try {
        let nexusData;
        await db.runTransaction(async (transaction) => {
            const nexusDoc = await transaction.get(nexusRef);
            const userDoc = await transaction.get(userProfileRef);

            if (!nexusDoc.exists) throw new HttpsError("not-found", "The specified Nexus does not exist.");
            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");

            nexusData = nexusDoc.data();
            if (nexusData.ownerId !== callerId) {
                throw new HttpsError("permission-denied", "Only the Nexus owner can create personas.");
            }
            if ((userDoc.data().tokens || 0) < PERSONA_CREATION_COST) {
                throw new HttpsError("resource-exhausted", `You need ${PERSONA_CREATION_COST} Echoes to forge a persona.`);
            }

            transaction.update(userProfileRef, { tokens: FieldValue.increment(-PERSONA_CREATION_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(PERSONA_CREATION_COST) });
            }
        });

        const bioPrompt = `Write a short, engaging, first-person bio (under 150 characters) for a persona named "${name}" who is "${bio_prompt}".`;
        const { text: generatedBio } = await generateAiContent(bioPrompt);
        if (!generatedBio) throw new HttpsError("internal", "AI failed to generate a bio for the persona.");

        const aiUserId = `ai-${nexusId.slice(0, 5)}-${name.toLowerCase().replace(/\s/g, '-')}`;
        const aiUserProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${aiUserId}`);

        await aiUserProfileRef.set({
            id: aiUserId,
            displayName: name,
            photoURL: `https://api.dicebear.com/7.x/bottts-neutral/svg?seed=${avatar_prompt || name.replace(/\s/g, '')}`,
            bio: generatedBio,
            interests: interests_list,
            isAI: true,
            nexusId: nexusId, // Links the AI to its home Nexus
            role: 'user',
            createdAt: FieldValue.serverTimestamp(),
            tokens: 0,
            reputationScore: 50,
        });

        await handleLuminanceUpdate(nexusId, 100); // Reward the Nexus for creating a persona

        return { success: true, message: `AI Persona "${name}" has been forged for your Nexus!` };
    } catch (error) {
        console.error("Error creating Nexus AI persona:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred.");
    }
});

// In index.js, add this new scheduled function to make Nexus AI post.
exports.postNexusAiWhisper = onSchedule({ ...functionOptions, schedule: "every 1 hours" }, async (event) => {
    console.log("Running scheduled job: postNexusAiWhisper");
    const aiUsersQuery = db.collection(`artifacts/${appId}/public/data/user_profiles`).where("isAI", "==", true).where("nexusId", "!=", null);
    const aiUsersSnapshot = await aiUsersQuery.get();
    if (aiUsersSnapshot.empty) return;

    for (const aiUserDoc of aiUsersSnapshot.docs) {
        const aiUser = aiUserDoc.data();
        const nexusId = aiUser.nexusId;

        try {
            const nexusDoc = await db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`).get();
            if (!nexusDoc.exists) continue;

            const prompt = `You are an AI persona named "${aiUser.displayName}" in a community called "${nexusDoc.data().name}". Your personality is: "${aiUser.bio}". Your interests are: ${aiUser.interests.join(', ')}. Write a short, in-character post (under 40 words) to start a conversation in the community.`;
            const { text: postContent } = await generateAiContent(prompt);

            if (postContent) {
                await db.collection(`artifacts/${appId}/public/data/nexuses/${nexusId}/posts`).add({
                    authorId: aiUser.id,
                    authorName: aiUser.displayName,
                    authorPhotoURL: aiUser.photoURL,
                    content: postContent,
                    timestamp: FieldValue.serverTimestamp(),
                    isAnonymous: false,
                    likes: [],
                    likesCount: 0,
                });
            }
        } catch (e) {
            console.error(`Error posting for AI ${aiUser.id} in Nexus ${nexusId}:`, e);
        }
    }
});

// In index.js, add this new trigger for Nexus AI chat interaction.
exports.invokeNexusAiEmissary = onDocumentWritten(`artifacts/${appId}/public/data/nexuses/{nexusId}/chat/{messageId}`, async (event) => {
    if (!event.data.after.exists || event.data.before.exists) return null;

    const messageData = event.data.after.data();
    const nexusId = event.params.nexusId;
    const authorId = messageData.from;

    // Find AI personas associated with this Nexus
    const nexusAIsQuery = db.collection(`artifacts/${appId}/public/data/user_profiles`).where("nexusId", "==", nexusId);
    const nexusAIsSnap = await nexusAIsQuery.get();
    if (nexusAIsSnap.empty) return null;

    const mentionedAI = nexusAIsSnap.docs.find(doc => messageData.content.toLowerCase().includes(`@${doc.data().displayName.toLowerCase()}`));

    if (!mentionedAI) return null;

    const aiData = mentionedAI.data();
    const chatCollectionRef = db.collection(`artifacts/${appId}/public/data/nexuses/${nexusId}/chat`);

    try {
        const recentMessagesQuery = chatCollectionRef.orderBy('timestamp', 'desc').limit(10);
        const messagesSnapshot = await recentMessagesQuery.get();
        const recentChatHistory = messagesSnapshot.docs.map(doc => `${doc.data().from}: ${doc.data().content}`).reverse().join('\n');

        const prompt = `You are the AI persona "${aiData.displayName}" with this personality: "${aiData.bio}". A user has mentioned you in the chat. Respond naturally and in-character to the following message, considering the recent chat history. Keep your response brief. \n\nHistory:\n${recentChatHistory}\n\nUser Message:\n"${messageData.content}"`;
        const { text: aiResponse } = await generateAiContent(prompt);

        if (aiResponse) {
            await chatCollectionRef.add({
                from: aiData.id, // Post as the AI persona
                content: aiResponse,
                timestamp: FieldValue.serverTimestamp(),
            });
        }
    } catch (error) {
        console.error(`Error invoking Nexus AI ${aiData.id}:`, error);
    }
    return null;
});
// In index.js, REPLACE the resetWeeklyQuestProgress function.
exports.resetWeeklyQuestProgress = onSchedule({ ...functionOptions, schedule: "every monday 00:00", timeZone: "America/New_York" }, async (event) => {
    const usersRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);
    const snapshot = await usersRef.where("isAI", "==", false).get();
    if (snapshot.empty) return null;

    const batch = db.batch();
    snapshot.forEach(doc => {
        const weeklyResetFields = {
            "weeklyQuestProgress.posts": 0,
            "weeklyQuestProgress.amplificationsReceived": 0,
            "weeklyQuestProgress.connectionsMade": 0,
            "weeklyQuestProgress.echoesSpent": 0,
            "weeklyQuestProgress.reputationGained": 0,
            "weeklyQuestProgress.harmonySyncs": 0,
            "weeklyQuestProgress.constellationsStarted": 0,
            "weeklyQuestProgress.startReputation": doc.data().reputationScore || 0, // Snapshot reputation
        };
        batch.update(doc.ref, weeklyResetFields);
    });
    await batch.commit();
    console.log(`Reset weekly quest progress for ${snapshot.size} users.`);
});
// In index.js, REPLACE the existing notifyOnNewMessage function with this definitive version.

exports.notifyOnNewMessage = onDocumentWritten(`artifacts/${appId}/private_chats/{chatId}/messages/{messageId}`, async (event) => {
    // 1. Ensure this only runs for new messages, not edits or deletes.
    if (!event.data.after.exists || event.data.before.exists) return null;

    const messageData = event.data.after.data();
    // 2. Ignore system messages or if a user messages themselves.
    if (messageData.from === 'system' || messageData.from === messageData.to) return null;

    const fromUserId = messageData.from;
    const toUserId = messageData.to;

    try {
        const fromUserProfileSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${fromUserId}`).get();
        if (!fromUserProfileSnap.exists) {
            console.error(`Notification failed: Sender profile ${fromUserId} not found.`);
            return null;
        }
        const fromUserName = fromUserProfileSnap.data().displayName || 'Someone';
        const contentPreview = messageData.content.substring(0, 100);

        // --- PART 1: SEND THE INSTANT PUSH NOTIFICATION ---
        const tokensSnapshot = await db.collection(`artifacts/${appId}/users/${toUserId}/private_tokens`).get();
        if (!tokensSnapshot.empty) {
            const tokens = tokensSnapshot.docs.map(doc => doc.id);

            const multicastPayload = {
                tokens: tokens,
                notification: {
                    title: `New message from ${fromUserName}`,
                    body: contentPreview,
                },
                webpush: {
                    fcm_options: {
                        link: `${process.env.BASE_URL || 'https://whispers-of-harmony.web.app'}?page=messages&chatPartnerId=${fromUserId}`
                    }
                }
            };

            const response = await getMessaging().sendEachForMulticast(multicastPayload);

            // Cleanup stale tokens
            const tokensToDelete = [];
            response.responses.forEach((result, index) => {
                if (!result.success && result.error.code === 'messaging/registration-token-not-registered') {
                    tokensToDelete.push(tokensSnapshot.docs[index].ref);
                }
            });
            if (tokensToDelete.length > 0) {
                const deleteBatch = db.batch();
                tokensToDelete.forEach(ref => deleteBatch.delete(ref));
                await deleteBatch.commit();
            }
        }

        // --- PART 2: THE DUAL IN-APP NOTIFICATION SYSTEM ---
        const batch = db.batch();

        // A) Create a temporary, unique "toast" notification that will ALWAYS be "added"
        const toastRef = db.collection(`artifacts/${appId}/users/${toUserId}/toast_notifications`).doc();
        batch.set(toastRef, {
            type: 'MESSAGE',
            fromUserName: fromUserName,
            fromUserId: fromUserId,
            message: `sent you a new message: "${contentPreview}..."`,
            timestamp: FieldValue.serverTimestamp(),
            navigation: { page: 'messages', params: { chatPartnerId: fromUserId } },
        });

        // B) Create or update the permanent, condensed notification for the main list
        const listNotificationRef = db.doc(`artifacts/${appId}/users/${toUserId}/notifications/message_${fromUserId}`);
        const listNotificationSnap = await listNotificationRef.get();

        if (listNotificationSnap.exists()) {
            // --- THIS IS THE FIX ---
            // Instead of trying to insert the count, we use a generic plural message.
            // The `count` field is still incremented correctly for the UI to use if needed.
            batch.update(listNotificationRef, {
                message: `sent you multiple new messages. The latest is: "${contentPreview}..."`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                count: FieldValue.increment(1)
            });
        } else {
            batch.set(listNotificationRef, {
                type: 'CONVERSATION_UPDATE',
                fromUserId: fromUserId,
                fromUserName: fromUserName,
                message: `sent you a new message: "${contentPreview}..."`,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
                navigation: { page: 'messages', params: { chatPartnerId: fromUserId } },
                chatPartnerId: fromUserId,
                count: 1,
            });
        }

        // --- PART 3: UPDATE USER PROFILE FOR UI INDICATORS ---
        const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${toUserId}`);
        batch.update(userProfileRef, {
            hasUnreadMessages: true,
            unreadChatPartners: FieldValue.arrayUnion(fromUserId)
        });

        await batch.commit();

    } catch (error) {
        console.error(`Error in smart notification flow for chat ${event.params.chatId}:`, error);
    }
    return null;
});
// In index.js, add this new scheduled function.

exports.cleanupToastNotifications = onSchedule({ ...functionOptions, schedule: "every 1 hours" }, async (event) => {
    console.log("Running scheduled job: cleanupToastNotifications");
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    // Query for all "toast_notifications" collection groups
    const oldToastsQuery = db.collectionGroup('toast_notifications').where('timestamp', '<=', twoMinutesAgo);

    try {
        const snapshot = await oldToastsQuery.get();
        if (snapshot.empty) {
            console.log("No old toast notifications to delete.");
            return null;
        }

        const batch = db.batch();
        snapshot.forEach(doc => {
            batch.delete(doc.ref);
        });

        await batch.commit();
        console.log(`Successfully deleted ${snapshot.size} old toast notifications.`);
        return null;

    } catch (error) {
        console.error("Error during cleanupToastNotifications job:", error);
        return null;
    }
});
// In index.js, REPLACE the placeholder helper function with this definitive version.

/**
 * Sends a push notification to a specific user via the configured Apilix API.
 * This function handles fetching the user's Apilix identity, constructing the
 * request body in the required format, and sending the notification.
 * @param {string} toUserId The Whispers of Harmony user ID of the recipient.
 * @param {string} title The title of the push notification.
 * @param {string} body The body/content of the push notification.
 */
const sendApilixPushNotification = async (toUserId, title, body) => {
    // 1. Securely retrieve API keys from the environment secrets.
    const appKey = process.env.APILIX_APP_KEY;
    const apiKey = process.env.APILIX_API_KEY;

    // Failsafe: If keys are not configured, log a critical error and exit.
    if (!appKey || !apiKey) {
        console.error("CRITICAL: Apilix keys are not configured in environment secrets. Push notifications are disabled.");
        return;
    }

    // 2. Fetch the recipient's unique Apilix ID from Firestore.
    // This ID must be saved by your frontend app when the user grants permission.
    const identityRef = db.doc(`artifacts/${appId}/users/${toUserId}/private_tokens/apilix_user_identity`);
    const identitySnap = await identityRef.get();

    // If the user hasn't registered for notifications, we can't send one.
    if (!identitySnap.exists) {
        console.log(`Notification not sent: User ${toUserId} does not have an Apilix user_identity.`);
        return;
    }
    const userIdentity = identitySnap.data().identity;

    // 3. Construct the API request exactly as specified by the Apilix documentation.
    const endpoint = "https://appilix.com/api/push-notification";

    // The Apilix API requires the data in 'application/x-www-form-urlencoded' format, not JSON.
    // The URLSearchParams object handles this formatting for us automatically.
    const bodyParams = new URLSearchParams({
        app_key: appKey,
        api_key: apiKey,
        notification_title: title,
        notification_body: body,
        user_identity: userIdentity,
    });

    try {
        // 4. Send the request to the Apilix API endpoint.
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: bodyParams,
        });

        const responseData = await response.json();

        // 5. Log the result for debugging purposes.
        if (responseData.status !== 'success') {
            console.error(`Apilix API returned an error for user ${toUserId}:`, responseData.message);
        } else {
            console.log(`Successfully sent Apilix notification to user ${toUserId}`);
        }
    } catch (error) {
        console.error("Fatal error while sending notification via Apilix API:", error);
    }
};

exports.moderateContentOnCreate = onDocumentWritten({
    document: `artifacts/${appId}/public/data/{collection}/{docId}`,
    // This will trigger for whispers in 'anonymous_entries' and comments in 'comments' subcollections
}, async (event) => {
    // Only run on creation
    if (event.data.before.exists) {
        return null;
    }

    const contentData = event.data.after.data();
    const contentRef = event.data.after.ref;

    // Do not moderate AI content or content without a 'content' field
    if (contentData.isAI || !contentData.content) {
        return null;
    }

    // Moderate video content via user reports, not direct analysis.
    // A more advanced (and expensive) implementation would use the Video Intelligence API.
    // For now, we rely on text and user flagging.
    if (contentData.mediaUrl && (contentData.mediaUrl.includes('.mp4') || contentData.mediaUrl.includes('.webm'))) {
        console.log(`Media content at ${contentRef.path} will be moderated via user reports.`);
    }

    try {
        const prompt = `
            Analyze the following text for violations of a community safety policy. The policy prohibits severe hate speech, explicit threats of violence, harassment, and sexually explicit content.
            Return a single JSON object with NO other text or formatting.
            The JSON object must have two keys:
            1. "violationScore": An integer from 0 (perfectly safe) to 10 (severe violation).
            2. "reason": A brief, neutral explanation for the score.

            Text to analyze: "${contentData.content}"
        `;

        const { text: jsonResponse } = await generateAiContent(prompt);

        if (!jsonResponse) {
            console.warn(`AI Moderator received no response for content ${contentRef.id}.`);
            return null;
        }

        const analysis = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
        const { violationScore, reason } = analysis;

        console.log(`Moderation result for ${contentRef.path}: Score ${violationScore}. Reason: ${reason}`);

        const HIGH_SEVERITY_THRESHOLD = 9;
        const MEDIUM_SEVERITY_THRESHOLD = 7;

        if (violationScore >= HIGH_SEVERITY_THRESHOLD) {
            console.log(`High severity violation detected. Deleting content ${contentRef.id}.`);
            await contentRef.delete();

            const logRef = db.collection(`artifacts/${appId}/private/moderation_logs`).doc();
            await logRef.set({
                action: 'auto-delete',
                contentId: contentRef.id,
                contentPath: contentRef.path,
                authorId: contentData.authorId,
                content: contentData.content,
                score: violationScore,
                reason: reason,
                timestamp: FieldValue.serverTimestamp()
            });

        } else if (violationScore >= MEDIUM_SEVERITY_THRESHOLD) {
            console.log(`Medium severity violation detected. Flagging content ${contentRef.id} for review.`);
            await contentRef.update({ isFlagged: true });
        }

        return null;

    } catch (error) {
        console.error(`Error in AI Guardian for content ${contentRef.id}:`, error);
        await contentRef.update({ isFlagged: true });
        return null;
    }
});


// --- OWNER & ECONOMIC HELPERS ---

exports.generateContentWithVertexAI = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
    const { prompt } = request.data;
    if (!prompt) throw new HttpsError("invalid-argument", "A valid prompt is required.");

    const result = await generateAiContent(prompt);
    if (result.text) {
        return { text: result.text };
    } else {
        throw new HttpsError("internal", "AI model returned an empty or invalid response.");
    }
});

// In index.js, add this entire new function.

// In index.js, REPLACE the existing getPersonalitySnapshot function with this one.
exports.getPersonalitySnapshot = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const { targetUserId } = request.data;
    const callerId = request.auth.uid;
    const TOKEN_COST = 30;

    if (!targetUserId) throw new HttpsError("invalid-argument", "A target user ID is required.");

    // --- STEP 1: Fetch data and perform AI operation FIRST ---
    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const q = whispersRef.where("authorId", "==", targetUserId).orderBy("timestamp", "desc").limit(25);
    const snapshot = await q.get();

    if (snapshot.docs.length < 5) {
        throw new HttpsError("failed-precondition", "This user hasn't shared enough whispers to generate a snapshot.");
    }

    const whispersText = snapshot.docs.map(doc => doc.data().content).join("\n---\n");
    const prompt = `Analyze the following user's writings based on the Big Five (OCEAN) personality model. Return a single, valid JSON object with NO other text or markdown. The JSON must have these keys: "openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism" (all integer scores 0-100), and "summary" (a concise, one-paragraph summary). Writings: "${whispersText}"`;

    const { text: jsonResponse } = await generateAiContent(prompt);
    if (!jsonResponse) {
        throw new HttpsError("internal", "The AI failed to generate a snapshot. You have not been charged.");
    }

    // --- STEP 2: Handle the economic transaction AFTER success ---
    const callerProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${callerId}`);
    const ownerId = await getOwnerAccountId();

    try {
        await db.runTransaction(async (transaction) => {
            const callerDoc = await transaction.get(callerProfileRef);
            if (!callerDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");
            if ((callerDoc.data().tokens || 0) < TOKEN_COST) {
                throw new HttpsError("resource-exhausted", `You need ${TOKEN_COST} Echoes for this analysis.`);
            }
            transaction.update(callerProfileRef, { tokens: FieldValue.increment(-TOKEN_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(TOKEN_COST) });
            }
        });

        const analysis = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
        return analysis;
    } catch (error) {
        console.error(`Error in getPersonalitySnapshot transaction for target ${targetUserId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An error occurred while processing your payment.");
    }
});
// In index.js, REPLACE the existing getConnectionCompass function with this one.
exports.getConnectionCompass = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const { targetUserId } = request.data;
    const callerId = request.auth.uid;
    const TOKEN_COST = 50;

    if (!targetUserId || targetUserId === callerId) {
        throw new HttpsError("invalid-argument", "A valid, different target user ID is required.");
    }

    // --- STEP 1: Fetch data and perform AI operation FIRST ---
    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const callerWhispersQuery = whispersRef.where("authorId", "==", callerId).orderBy("timestamp", "desc").limit(15).get();
    const targetWhispersQuery = whispersRef.where("authorId", "==", targetUserId).orderBy("timestamp", "desc").limit(15).get();
    const targetProfileQuery = db.doc(`artifacts/${appId}/public/data/user_profiles/${targetUserId}`).get();

    const [callerWhispersSnap, targetWhispersSnap, targetProfileDoc] = await Promise.all([callerWhispersQuery, targetWhispersQuery, targetProfileQuery]);

    if (callerWhispersSnap.docs.length < 3 || targetWhispersSnap.docs.length < 3) {
        throw new HttpsError("failed-precondition", "One or both users have not shared enough whispers for an accurate analysis.");
    }

    const callerWhispersText = callerWhispersSnap.docs.map(doc => doc.data().content).join("\n");
    const targetWhispersText = targetWhispersSnap.docs.map(doc => doc.data().content).join("\n");
    const targetBio = targetProfileDoc.data()?.bio || "an interesting person";

    const prompt = `Analyze the potential for connection between User A (the caller) and User B (the target). Return a single, valid JSON object with NO other text or formatting. The JSON must have these keys: "compatibilityScore" (integer 0-100), "syncs" (array of 2-3 brief strings of shared themes), "dissonances" (array of 1-2 brief strings of potential conflicts), and "summary" (a concise, one-paragraph explanation). User A's Writings: "${callerWhispersText}" --- User B's Bio & Writings: "${targetBio}" "${targetWhispersText}"`;

    const { text: jsonResponse } = await generateAiContent(prompt);
    if (!jsonResponse) {
        throw new HttpsError("internal", "The AI failed to generate a connection analysis. You have not been charged.");
    }

    // --- STEP 2: Handle the economic transaction AFTER success ---
    const callerProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${callerId}`);
    const ownerId = await getOwnerAccountId();

    try {
        await db.runTransaction(async (transaction) => {
            const callerDoc = await transaction.get(callerProfileRef);
            if (!callerDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");
            if ((callerDoc.data().tokens || 0) < TOKEN_COST) {
                throw new HttpsError("resource-exhausted", `You need ${TOKEN_COST} Echoes for a Connection Compass.`);
            }
            transaction.update(callerProfileRef, { tokens: FieldValue.increment(-TOKEN_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(TOKEN_COST) });
            }
        });

        const analysis = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
        return analysis;
    } catch (error) {
        console.error(`Error in getConnectionCompass transaction for target ${targetUserId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An error occurred while processing your payment.");
    }
});
/**
 * Atomically updates Nexus quest progress and luminance when a new post or chat message is created.
 * This function is designed to be resilient against race conditions.
 */
exports.updateNexusOnActivity = onDocumentWritten(`artifacts/${appId}/public/data/nexuses/{nexusId}/{activityCollection}/{docId}`, async (event) => {
    // Only process the creation of a new document
    if (!event.data.after.exists || event.data.before.exists) return null;

    const nexusId = event.params.nexusId;
    const activityCollection = event.params.activityCollection;
    const data = event.data.after.data();

    let baseLuminanceAward = 0;
    let questUpdateType = null;

    // Determine the type of activity and its base reward
    if (activityCollection === 'posts') {
        baseLuminanceAward = 10;
        questUpdateType = data.mediaUrl ? 'post_media' : 'post';
    } else if (activityCollection === 'chat') {
        // Ignore AI or system messages for rewards
        if (data.from === 'system' || data.from === 'ai-emissary') return null;
        baseLuminanceAward = 1;
        questUpdateType = 'chat';
    } else {
        // Not an activity we track for luminance/quests
        return null;
    }

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const questRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}/metadata/active_quests`);

    try {
        await db.runTransaction(async (transaction) => {
            const [nexusDoc, questDoc] = await Promise.all([
                transaction.get(nexusRef),
                transaction.get(questRef)
            ]);

            if (!nexusDoc.exists || !questDoc.exists) {
                console.log(`Nexus (${nexusDoc.exists}) or Quests (${questDoc.exists}) doc not found for ${nexusId}. Aborting activity update.`);
                return;
            }

            const questData = questDoc.data();
            const quests = questData.quests;
            let questLuminanceAward = 0;
            let questsModified = false;

            // Atomically update quest progress
            for (const questId in quests) {
                const quest = quests[questId];
                // Check if quest is active and matches the activity type
                if (!quest.completed && quest.type === questUpdateType) {
                    const newProgress = (quest.progress || 0) + 1;
                    const fieldPath = `quests.${questId}.progress`;
                    transaction.update(questRef, { [fieldPath]: FieldValue.increment(1) });
                    questsModified = true;

                    // If the quest is now complete, add its reward
                    if (newProgress >= quest.target) {
                        const completedFieldPath = `quests.${questId}.completed`;
                        transaction.update(questRef, { [completedFieldPath]: true });
                        questLuminanceAward += quest.luminance;
                    }
                }
            }

            // Atomically update Nexus luminance and handle level-ups
            const totalLuminanceToAdd = baseLuminanceAward + questLuminanceAward;
            if (totalLuminanceToAdd > 0) {
                const levelUpData = _calculateLevelUp(nexusDoc.data(), totalLuminanceToAdd);
                delete levelUpData.leveledUp; // Remove helper flag
                transaction.update(nexusRef, levelUpData);
            }
        });
    } catch (error) {
        console.error(`Error in transaction for Nexus activity ${nexusId}:`, error);
    }

    return null;
});
// In index.js, add this new constant near the top with your other definitions.
const nexusQuestDefinitions = {
    // Tier 1: Common Quests
    'amplification_drive_1': { title: 'Starlight Drive', description: 'Amplify 10 whispers from outside the Nexus.', target: 10, luminance: 100, type: 'amplify' },
    'post_frenzy_1': { title: 'Creative Spark', description: 'Post 25 new whispers within the Nexus.', target: 25, luminance: 75, type: 'post' },
    'chatterbox_1': { title: 'Nexus Buzz', description: 'Send 100 chat messages in the Nexus chat.', target: 100, luminance: 50, type: 'chat' },
    'media_share_1': { title: 'Show and Tell', description: 'Post 10 whispers containing media (images/videos) in the Nexus.', target: 10, luminance: 120, type: 'post_media' },

    // Tier 2: Uncommon Quests (for higher level Nexuses)
    'amplification_drive_2': { title: 'Supernova Surge', description: 'Amplify 50 whispers from outside the Nexus.', target: 50, luminance: 500, type: 'amplify', minLevel: 5 },
    'post_frenzy_2': { title: 'Content Cascade', description: 'Post 100 new whispers within the Nexus.', target: 100, luminance: 350, type: 'post', minLevel: 5 },
};

// In index.js, add this entire new scheduled function.
exports.generateWeeklyNexusQuests = onSchedule({ ...functionOptions, schedule: "every monday 05:00", timeZone: "America/New_York" }, async (event) => {
    console.log("Running scheduled job: generateWeeklyNexusQuests");
    const nexusesRef = db.collection(`artifacts/${appId}/public/data/nexuses`);
    const snapshot = await nexusesRef.get();

    if (snapshot.empty) {
        console.log("No nexuses found to generate quests for.");
        return null;
    }

    const batch = db.batch();
    const allQuests = Object.keys(nexusQuestDefinitions);

    for (const nexusDoc of snapshot.docs) {
        const nexusData = nexusDoc.data();
        const nexusLevel = nexusData.level || 1;

        // Filter quests available for the Nexus's level
        const availableQuests = allQuests.filter(id => {
            const quest = nexusQuestDefinitions[id];
            return !quest.minLevel || nexusLevel >= quest.minLevel;
        });

        // Select 3 random quests
        const selectedQuestIds = availableQuests.sort(() => 0.5 - Math.random()).slice(0, 3);

        const activeQuests = {};
        selectedQuestIds.forEach(id => {
            activeQuests[id] = {
                progress: 0,
                completed: false,
                ...nexusQuestDefinitions[id]
            };
        });

        const questRef = nexusDoc.ref.collection('metadata').doc('active_quests');
        batch.set(questRef, { quests: activeQuests, generatedAt: FieldValue.serverTimestamp() });
    }

    await batch.commit();
    console.log(`Generated weekly quests for ${snapshot.size} nexuses.`);
    return null;
});

// In index.js, REPLACE the enhanceBio function with this one.
exports.enhanceBio = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const { currentBio } = request.data;
    const userId = request.auth.uid;
    const TOKEN_COST = 15;

    const prompt = `You are a creative social media profile writer. Given the following bio, write three new, distinct, and more engaging versions, each under 150 characters. Return a single, valid JSON object with one key, "suggestions", which is an array of the three new bio strings. Bio to enhance: "${currentBio || 'A person of mystery.'}"`;

    const { text: jsonResponse } = await generateAiContent(prompt);
    if (!jsonResponse) throw new HttpsError("internal", "The AI failed to generate suggestions. You have not been charged.");

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const ownerId = await getOwnerAccountId();
    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "Your profile could not be found.");
            if ((userDoc.data().tokens || 0) < TOKEN_COST) throw new HttpsError("resource-exhausted", `You need ${TOKEN_COST} Echoes.`);
            transaction.update(userProfileRef, { tokens: FieldValue.increment(-TOKEN_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(TOKEN_COST) });
            }
        });
        const analysis = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
        return analysis;
    } catch (error) {
        console.error(`Error in enhanceBio transaction for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An error occurred while processing your payment.");
    }
});

// In index.js, REPLACE the getThematicCloud function with this one.
exports.getThematicCloud = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const { targetUserId } = request.data;
    const callerId = request.auth.uid;
    const TOKEN_COST = 40;
    if (!targetUserId) throw new HttpsError("invalid-argument", "A target user ID is required.");

    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const q = whispersRef.where("authorId", "==", targetUserId).orderBy("timestamp", "desc").limit(50);
    const snapshot = await q.get();
    if (snapshot.docs.length < 10) throw new HttpsError("failed-precondition", "This user needs at least 10 whispers to generate a Soul-Cloud.");

    const whispersText = snapshot.docs.map(doc => doc.data().content).join("\n---\n");
    const prompt = `Analyze the following writings. Identify the top 10 most prominent emotional themes or concepts. Return a single, valid JSON object with one key, "themes", which is an array of objects. Each object must have "theme" (a 1-2 word string) and "weight" (integer 1-5). Writings: "${whispersText}"`;

    const { text: jsonResponse } = await generateAiContent(prompt);
    if (!jsonResponse) throw new HttpsError("internal", "The AI failed to generate an analysis. You have not been charged.");

    const callerProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${callerId}`);
    const ownerId = await getOwnerAccountId();
    try {
        await db.runTransaction(async (transaction) => {
            const callerDoc = await transaction.get(callerProfileRef);
            if (!callerDoc.exists) throw new HttpsError("not-found", "Your profile could not be found.");
            if ((callerDoc.data().tokens || 0) < TOKEN_COST) throw new HttpsError("resource-exhausted", `You need ${TOKEN_COST} Echoes.`);
            transaction.update(callerProfileRef, { tokens: FieldValue.increment(-TOKEN_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(TOKEN_COST) });
            }
        });
        const analysis = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
        return analysis;
    } catch (error) {
        console.error(`Error in getThematicCloud transaction for target ${targetUserId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An error occurred while processing your payment.");
    }
});


// In index.js, REPLACE the getNexusRecommendations function with this one.
exports.getNexusRecommendations = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const userId = request.auth.uid;
    const RECOMMENDATION_COST = 50;

    const whispersQuery = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).where("authorId", "==", userId).orderBy("timestamp", "desc").limit(20);
    const nexusesQuery = db.collection(`artifacts/${appId}/public/data/nexuses`).where('privacy', '==', 'public');
    const [whispersSnapshot, nexusesSnapshot] = await Promise.all([whispersQuery.get(), nexusesQuery.get()]);

    if (whispersSnapshot.docs.length < 5) throw new HttpsError("failed-precondition", "You need at least 5 whispers for an accurate recommendation.");
    if (nexusesSnapshot.empty) throw new HttpsError("not-found", "There are no public Nexuses to recommend.");

    const userWhispersText = whispersSnapshot.docs.map(doc => doc.data().content).join("\n---\n");
    const nexusList = nexusesSnapshot.docs.map(doc => ({ id: doc.id, name: doc.data().name, description: doc.data().description }));
    const prompt = `You are a community matchmaker. Recommend the 3 best communities (Nexuses) for a user based on their writings. Return a single, valid JSON object with one key, "recommendations", which is an array of exactly 3 objects. Each object must have "nexusId" (string) and "reason" (a short, one-sentence explanation). USER'S WRITINGS: "${userWhispersText}" AVAILABLE NEXUSES: ${JSON.stringify(nexusList)}`;

    const { text: jsonResponse } = await generateAiContent(prompt);
    if (!jsonResponse) throw new HttpsError("internal", "The AI matchmaker failed to respond. You have not been charged.");

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const ownerId = await getOwnerAccountId();
    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "Your profile not found.");
            if ((userDoc.data().tokens || 0) < RECOMMENDATION_COST) throw new HttpsError("resource-exhausted", `You need ${RECOMMATION_COST} Echoes.`);
            transaction.update(userProfileRef, { tokens: FieldValue.increment(-RECOMMATION_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(RECOMMATION_COST) });
            }
        });
        const analysis = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
        if (!analysis.recommendations || analysis.recommendations.length === 0) throw new HttpsError("internal", "The AI could not find suitable recommendations.");
        return analysis;
    } catch (error) {
        console.error(`Error in getNexusRecommendations transaction for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An error occurred during payment processing.");
    }
});

exports.getCommentVibe = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
    const { entryId } = request.data;
    if (!entryId) throw new HttpsError("invalid-argument", "An entry ID is required.");

    const commentsRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries/${entryId}/comments`);
    const snapshot = await commentsRef.limit(20).get();
    if (snapshot.empty) {
        return { vibe: "This conversation is just getting started. Be the first to set the tone!" };
    }

    const commentsText = snapshot.docs.map(doc => doc.data().content).join("\n---\n");
    const prompt = `Analyze the overall "vibe" of the following comment thread. Describe it in one short, engaging sentence. Examples: "This is a really supportive and encouraging conversation.", "Things are getting a little heated in this intense debate.", "A very humorous and lighthearted discussion."\n\nComments:\n${commentsText}`;

    const { text: vibe } = await generateAiContent(prompt);
    return { vibe: vibe || "Could not determine the vibe." };
});

// In index.js, REPLACE the existing getPersonalizedFeed function.
exports.getPersonalizedFeed = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }
    const { offset = 0, limit = 10 } = request.data;
    const userId = request.auth.uid;

    try {
        let query = db.collection(`artifacts/${appId}/public/data/anonymous_entries`)
            .where("isSealed", "==", false)
            .orderBy("timestamp", "desc");

        const snapshot = await query.get();

        let whispers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Filter out the user's own whispers and paginate on the server
        whispers = whispers.filter(w => w.authorId !== userId);
        const paginatedWhispers = whispers.slice(offset, offset + limit);

        // Prepend the spotlight whisper only on the first page load
        if (offset === 0) {
            const spotlightDoc = await db.doc(`artifacts/${appId}/public/data/app_metadata/current_spotlight`).get();
            if (spotlightDoc.exists() && spotlightDoc.data().entryId) {
                const spotlightWhisperDoc = await db.doc(`artifacts/${appId}/public/data/anonymous_entries/${spotlightDoc.data().entryId}`).get();
                if (spotlightWhisperDoc.exists()) {
                    const spotlightWhisper = { id: spotlightWhisperDoc.id, ...spotlightWhisperDoc.data(), isSpotlight: true };
                    // Ensure spotlight isn't duplicated
                    const feedWithoutSpotlight = paginatedWhispers.filter(w => w.id !== spotlightWhisper.id);
                    return { feed: [spotlightWhisper, ...feedWithoutSpotlight] };
                }
            }
        }

        return { feed: paginatedWhispers };

    } catch (error) {
        console.error(`Error in getPersonalizedFeed for user ${userId}:`, error);
        throw new HttpsError("internal", "Could not load the feed at this time.");
    }
});


exports.calculateConstellationDynamics = onSchedule({ ...functionOptions, schedule: "every 15 minutes" }, async (event) => {
    console.log("Running scheduled job: calculateConstellationDynamics");
    const usersRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);
    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const dynamicsRef = db.collection(`artifacts/${appId}/public/data/constellation_dynamics`);

    try {
        const usersSnapshot = await usersRef.where("isAI", "==", false).get();
        if (usersSnapshot.empty) {
            console.log("No users to process.");
            return null;
        }

        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const connectionsSnapshot = await db.collection(`artifacts/${appId}/users/${userId}/connections`).get();
            const connectionIds = connectionsSnapshot.docs.map(doc => doc.data().followingId);

            if (connectionIds.length === 0) {
                await dynamicsRef.doc(userId).set({ mood: 'neutral', syncs: [] });
                continue;
            }

            // --- 1. Emotional Weather Calculation ---
            const recentWhispersQuery = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).where("authorId", "in", connectionIds).orderBy("timestamp", "desc").limit(20);
            const whispersSnapshot = await recentWhispersQuery.get();
            const whispers = whispersSnapshot.docs.map(doc => doc.data());

            let positiveCount = 0;
            let negativeCount = 0;

            whispers.forEach(whisper => {
                const content = whisper.content.toLowerCase();
                if (/\b(love|happy|joy|great|amazing|excited|beautiful)\b/.test(content)) positiveCount++;
                if (/\b(sad|angry|frustrated|anxious|lost|confused|bad)\b/.test(content)) negativeCount++;
            });

            let mood = 'neutral';
            if (positiveCount > negativeCount && positiveCount > whispers.length * 0.25) mood = 'positive';
            if (negativeCount > positiveCount && negativeCount > whispers.length * 0.25) mood = 'negative';

            // --- 2. Synchronicity Calculation (Simplified for cost) ---
            const syncs = [];
            const tagMap = new Map();
            whispers.forEach((whisper) => {
                whisper.tags?.forEach(tag => {
                    if (tagMap.has(tag)) {
                        tagMap.get(tag).push(whisper.authorId);
                    } else {
                        tagMap.set(tag, [whisper.authorId]);
                    }
                });
            });

            for (const [tag, userIds] of tagMap.entries()) {
                const uniqueUserIds = [...new Set(userIds)];
                if (uniqueUserIds.length > 1) {
                    syncs.push({
                        users: uniqueUserIds,
                        theme: tag,
                    });
                }
            }

            await dynamicsRef.doc(userId).set({
                mood: mood,
                syncs: syncs.slice(0, 3),
                lastUpdated: FieldValue.serverTimestamp()
            });
        }
        console.log(`Successfully calculated dynamics for ${usersSnapshot.size} users.`);
        return null;
    } catch (error) {
        console.error("Error calculating constellation dynamics:", error);
        return null;
    }
});
// =====================================================================
// == Creator Toolkit & Monetization Functions
// =====================================================================

exports.tipAuthor = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in to tip.");

    const { authorId, whisperId, tipAmount } = request.data;
    const tipperId = request.auth.uid;

    if (!authorId || !whisperId || !tipAmount || tipAmount <= 0) {
        throw new HttpsError("invalid-argument", "Invalid tipping information provided.");
    }
    if (authorId === tipperId) {
        throw new HttpsError("failed-precondition", "You cannot tip yourself.");
    }

    const tipperRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(tipperId);
    const authorRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(authorId);

    try {
        await db.runTransaction(async (transaction) => {
            const tipperDoc = await transaction.get(tipperRef);
            if (!tipperDoc.exists || tipperDoc.data().tokens < tipAmount) {
                throw new HttpsError("resource-exhausted", "You do not have enough Echoes to send this tip.");
            }

            transaction.update(tipperRef, { tokens: FieldValue.increment(-tipAmount) });
            transaction.update(authorRef, { tokens: FieldValue.increment(tipAmount) });
        });
        return { success: true };
    } catch (error) {
        console.error("Error in tipAuthor transaction:", error);
        throw new HttpsError("internal", error.message || "An unknown error occurred during the tip.");
    }
});

exports.getCreatorInsights = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
    const userId = request.auth.uid;

    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const q = whispersRef.where("authorId", "==", userId).orderBy("timestamp", "desc").limit(25);
    const snapshot = await q.get();

    if (snapshot.empty) {
        return { insight: "You haven't posted enough Whispers to generate an insight. Keep sharing your thoughts!" };
    }

    const whispersText = snapshot.docs.map(doc => doc.data().content).join("\n\n");
    const prompt = `Analyze the following collection of a user's journal entries ("Whispers"). Identify the top 2-3 recurring themes or topics. Based on these themes, provide a concise, encouraging, and insightful summary for the creator. Speak directly to them ("Your audience..."). Example: "Your audience deeply connects with your thoughts on personal growth and technology. They seem most engaged when you are vulnerable and reflective."\n\nWhispers:\n${whispersText}`;

    const { text: insight } = await generateAiContent(prompt);
    return { insight: insight || "Could not generate an insight at this time." };
});



exports.revealSealedWhispers = onSchedule({ ...functionOptions, schedule: "every 5 minutes" }, async (event) => {
    console.log("Running scheduled job: revealSealedWhispers");
    const now = new Date();

    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const queryForSealed = whispersRef.where("isSealed", "==", true).where("unsealTimestamp", "<=", now);

    try {
        const snapshot = await queryForSealed.get();
        if (snapshot.empty) {
            console.log("No whispers to unseal at this time.");
            return null;
        }

        const notificationBatch = db.batch();

        for (const whisperDoc of snapshot.docs) {
            const whisperData = whisperDoc.data();
            const authorId = whisperData.authorId;
            const bidPool = whisperData.sealBidPool || 0;

            const authorRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(authorId);

            await db.runTransaction(async (transaction) => {
                if (authorId && bidPool > 0) {
                    transaction.update(authorRef, { tokens: FieldValue.increment(bidPool) });
                }
                transaction.update(whisperDoc.ref, { isSealed: false });
            });

            const notificationRef = db.collection(`artifacts/${appId}/users/${authorId}/notifications`).doc();
            notificationBatch.set(notificationRef, {
                type: 'SEAL_REVEALED',
                message: `Your sealed whisper, "${whisperData.sealTitle}," has been unsealed!`,
                reward: bidPool,
                whisperId: whisperDoc.id,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
            });

            console.log(`Unsealing whisper ${whisperDoc.id} and awarding ${bidPool} Echoes to author ${authorId}.`);
        }

        await notificationBatch.commit();
        console.log(`Successfully unsealed ${snapshot.size} whispers and sent notifications.`);
        return null;

    } catch (error) {
        console.error("Error during revealSealedWhispers job:", error);
        return null;
    }
});

exports.bidOnSealedWhisper = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to bid on a whisper.");
    }

    const { whisperId, amount } = request.data;
    const userId = request.auth.uid;

    if (!whisperId || !amount || amount <= 0) {
        throw new HttpsError("invalid-argument", "A valid whisper ID and bid amount are required.");
    }

    const userProfileRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(userId);
    const sealedWhisperRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).doc(whisperId);

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            const whisperDoc = await transaction.get(sealedWhisperRef);

            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");
            if (!whisperDoc.exists) throw new HttpsError("not-found", "The whisper you are bidding on does not exist.");

            const userData = userDoc.data();
            const whisperData = whisperDoc.data();

            if (!whisperData.isSealed) {
                throw new HttpsError("failed-precondition", "This whisper is no longer sealed.");
            }

            if (whisperData.authorId === userId) {
                throw new HttpsError("failed-precondition", "You cannot bid on your own sealed whisper.");
            }

            if (userData.tokens < amount) {
                throw new HttpsError("resource-exhausted", `You do not have enough Echoes to place this bid.`);
            }

            const bidderMapField = `sealBidders.${userId}`;
            transaction.update(userProfileRef, { tokens: FieldValue.increment(-amount) });
            transaction.update(sealedWhisperRef, {
                sealBidPool: FieldValue.increment(amount),
                [bidderMapField]: FieldValue.increment(amount)
            });
        });

        return { success: true, message: "Your bid has been placed successfully!" };
    } catch (error) {
        console.error("Error bidding on whisper:", error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError("internal", "An unknown error occurred while placing your bid.");
    }
});

exports.sealWhisper = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to seal a whisper.");
    }

    const { title, content, tags, unsealDurationDays, keyPrice } = request.data;
    const userId = request.auth.uid;

    if (!title || !content || !unsealDurationDays) {
        throw new HttpsError("invalid-argument", "A title, content, and unseal duration are required.");
    }

    const userProfileRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(userId);

    try {
        const userDoc = await userProfileRef.get();
        if (!userDoc.exists) {
            throw new HttpsError("not-found", "Your user profile could not be found.");
        }

        const userData = userDoc.data();
        const reputationScore = userData.reputationScore || 0;
        const REPUTATION_THRESHOLD = 250;

        if (reputationScore < REPUTATION_THRESHOLD) {
            throw new HttpsError("permission-denied", `You need a reputation score of at least ${REPUTATION_THRESHOLD} to seal a whisper.`);
        }

        const unsealTimestamp = new Date(Date.now() + unsealDurationDays * 24 * 60 * 60 * 1000);

        const newWhisperRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).doc();
        await newWhisperRef.set({
            authorId: userId,
            authorName: userData.displayName || 'Anonymous User',
            authorReputationAtSeal: reputationScore,
            content: content,
            tags: tags || [],
            timestamp: FieldValue.serverTimestamp(),
            isAnonymous: true,
            isSealed: true,
            sealTitle: title,
            unsealTimestamp: unsealTimestamp,
            sealKeyPrice: keyPrice || 0,
            sealBidPool: 0,
            sealBidders: {},
            isEcho: false,
            echoedWhisperId: null,
            isSeed: false,
            constellationId: null,
            parentWhisperId: null,
            likes: [], dislikes: [], likesCount: 0, dislikesCount: 0,
            echoesInvested: 0,
            amplifiedBy: [],
            trendingScore: 0,
        });

        return { success: true, whisperId: newWhisperRef.id, message: "Your whisper has been sealed and posted." };

    } catch (error) {
        console.error("Error sealing whisper:", error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError("internal", "An unknown error occurred while sealing your whisper.");
    }
});

exports.echoWhisper = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to echo a whisper.");
    }

    const { originalWhisperId, content, tags } = request.data;
    const userId = request.auth.uid;

    if (!originalWhisperId || !content) {
        throw new HttpsError("invalid-argument", "The original whisper's ID and your new content are required.");
    }

    const costToEcho = 15;
    const authorRoyalty = 3;

    const userProfileRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(userId);
    const originalWhisperRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).doc(originalWhisperId);

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            const originalWhisperDoc = await transaction.get(originalWhisperRef);

            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");
            if (!originalWhisperDoc.exists) throw new HttpsError("not-found", "The whisper you are trying to echo does not exist.");

            const userData = userDoc.data();
            const originalWhisperData = originalWhisperDoc.data();

            if (userData.tokens < costToEcho) {
                throw new HttpsError("resource-exhausted", `You need ${costToEcho} Echoes to post an Echo.`);
            }

            const originalAuthorId = originalWhisperData.authorId;
            if (originalAuthorId) {
                const originalAuthorRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(originalAuthorId);
                transaction.update(originalAuthorRef, { tokens: FieldValue.increment(authorRoyalty) });

                const notificationRef = db.collection(`artifacts/${appId}/users/${originalAuthorId}/notifications`).doc();
                transaction.set(notificationRef, {
                    type: 'ECHO',
                    fromUserName: userData.displayName || 'An anonymous user',
                    message: `echoed your whisper, "${originalWhisperData.content.substring(0, 30)}..."!`,
                    reward: authorRoyalty,
                    whisperId: originalWhisperId,
                    timestamp: FieldValue.serverTimestamp(),
                    read: false,
                });
            }

            transaction.update(userProfileRef, { tokens: FieldValue.increment(-costToEcho) });

            const newEchoRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).doc();
            transaction.set(newEchoRef, {
                authorId: userId, authorName: userData.displayName || 'Anonymous User', content: content,
                tags: tags || [], timestamp: FieldValue.serverTimestamp(), isAnonymous: true,
                isEcho: true, echoedWhisperId: originalWhisperId,
                isSeed: false, constellationId: null, parentWhisperId: null,
                likes: [], dislikes: [], likesCount: 0, dislikesCount: 0,
                echoesInvested: 0, amplifiedBy: [], trendingScore: 0,
            });
        });

        return { success: true, message: "Your Echo has been posted to the feed!" };
    } catch (error) {
        console.error("Error creating Echo Whisper:", error);
        throw new HttpsError("internal", error.message || "An unknown error occurred.");
    }
});

// In index.js, REPLACE the existing openEchoChamber function with this one.

exports.openEchoChamber = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to open an Echo Chamber.");
    }
    const userId = request.auth.uid;
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        let reward;

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "Your profile could not be found.");

            const userData = userDoc.data();
            if (userData.lastChamberOpen) {
                const lastOpen = userData.lastChamberOpen.toDate();
                // Use a 22-hour cooldown to be safe
                if (Date.now() - lastOpen.getTime() < 22 * 60 * 60 * 1000) {
                    throw new HttpsError("failed-precondition", "Your Echo Chamber is still charging.");
                }
            }

            // --- THIS IS THE FIX: Securely increment the daily quest counter inside the transaction ---
            transaction.update(userProfileRef, {
                lastChamberOpen: FieldValue.serverTimestamp(),
                "dailyQuestProgress.echoChambersOpened": FieldValue.increment(1)
            });
        });

        // Determine the reward after the transaction is successful
        const randomNumber = Math.random();

        if (randomNumber < 0.50) { // 50% chance
            const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
            const q = whispersRef.where("authorId", "!=", userId).orderBy("trendingScore", "desc").limit(50);
            const snapshot = await q.get();
            if (!snapshot.empty) {
                const whispers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                reward = { type: 'LOST_WHISPER', data: whispers[Math.floor(Math.random() * whispers.length)] };
            }
        } else if (randomNumber < 0.80) { // 30% chance
            const prompt = "Generate a fun, creative, and slightly mystical journal prompt as a single, thought-provoking question.";
            const { text: generatedPrompt } = await generateAiContent(prompt);
            reward = { type: 'CRYSTAL_BALL_PROMPT', data: { prompt: generatedPrompt || "What is a small joy you can create for yourself today?" } };
        } else if (randomNumber < 0.98) { // 18% chance
            const amount = Math.floor(Math.random() * 76) + 25; // 25-100 Echoes
            await userProfileRef.update({ tokens: FieldValue.increment(amount) });
            reward = { type: 'ECHO_TROVE', data: { amount } };
        } else { // 2% chance
            const allUsers = await db.collection(`artifacts/${appId}/public/data/user_profiles`).where("isAI", "==", false).get();
            const otherUsers = allUsers.docs.filter(doc => doc.id !== userId);
            if (otherUsers.length > 0) {
                const randomUserDoc = otherUsers[Math.floor(Math.random() * otherUsers.length)];
                const randomUserData = randomUserDoc.data();
                reward = { type: 'HARMONY_CONNECTION', data: { userId: randomUserDoc.id, displayName: randomUserData.displayName, photoURL: randomUserData.photoURL } };
            }
        }

        // Fallback reward if any of the above fail to generate one
        if (!reward) {
            const amount = 10;
            await userProfileRef.update({ tokens: FieldValue.increment(amount) });
            reward = { type: 'ECHO_TROVE', data: { amount } };
        }

        return reward;

    } catch (error) {
        console.error("Error opening Echo Chamber:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unknown error occurred.");
    }
});

// In index.js, add these three new functions.

exports.giftEchoes = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const { recipientId, amount, message } = request.data;
    const senderId = request.auth.uid;
    const numAmount = Number(amount);

    if (!recipientId || !numAmount || numAmount <= 0) {
        throw new HttpsError("invalid-argument", "A recipient and a valid amount are required.");
    }
    if (senderId === recipientId) throw new HttpsError("failed-precondition", "You cannot gift to yourself.");

    const senderRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${senderId}`);
    const recipientRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${recipientId}`);
    const ownerId = await getOwnerAccountId();
    const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);

    try {
        await db.runTransaction(async (transaction) => {
            const [senderDoc, recipientDoc, ownerDoc] = await Promise.all([
                transaction.get(senderRef),
                transaction.get(recipientRef),
                transaction.get(ownerRef)
            ]);

            if (!senderDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");
            if (!recipientDoc.exists) throw new HttpsError("not-found", "The recipient's profile could not be found.");
            if ((senderDoc.data().tokens || 0) < numAmount) {
                throw new HttpsError("resource-exhausted", "You do not have enough Echoes.");
            }

            const platformFee = Math.floor(numAmount * 0.10);
            const recipientGets = numAmount - platformFee;

            transaction.update(senderRef, { tokens: FieldValue.increment(-numAmount) });
            transaction.update(recipientRef, { tokens: FieldValue.increment(recipientGets) });
            if (ownerId && platformFee > 0) {
                transaction.update(ownerRef, { tokens: FieldValue.increment(platformFee) });
            }

            const chatId = [senderId, recipientId].sort().join('_');
            const messageRef = db.collection(`artifacts/${appId}/private_chats/${chatId}/messages`).doc();
            transaction.set(messageRef, {
                from: 'system', to: recipientId, content: `${senderDoc.data().displayName} gifted ${numAmount} Echoes. ${message || ''}`,
                timestamp: FieldValue.serverTimestamp(), isGift: true
            });
        });

        // Send Notifications AFTER the transaction succeeds
        const senderSnap = await senderRef.get();
        const senderName = senderSnap.data().displayName || 'Someone';
        const batch = db.batch();
        const notificationMessage = `sent you a gift of ${numAmount} Echoes!`;
        const navigation = { page: 'messages', params: { chatPartnerId: senderId } };

        // 1. Toast Notification for recipient
        const toastRef = db.collection(`artifacts/${appId}/users/${recipientId}/toast_notifications`).doc();
        batch.set(toastRef, {
            type: 'GIFT', fromUserName: senderName, fromUserId: senderId,
            message: notificationMessage, timestamp: FieldValue.serverTimestamp(), navigation: navigation
        });

        // 2. List Notification for recipient
        const listNotificationRef = db.collection(`artifacts/${appId}/users/${recipientId}/notifications`).doc();
        batch.set(listNotificationRef, {
            type: 'GIFT', fromUserName: senderName, fromUserId: senderId,
            message: notificationMessage, navigation: navigation, timestamp: FieldValue.serverTimestamp(), read: false
        });
        await batch.commit();

        return { success: true };
    } catch (error) {
        console.error("Error in giftEchoes transaction:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unknown error occurred while sending the gift.");
    }
});
// In index.js, REPLACE the existing logMessageActivity function with this one.

exports.logMessageActivity = onDocumentWritten(`artifacts/${appId}/private_chats/{chatId}/messages/{messageId}`, async (event) => {
    if (!event.data.after.exists || event.data.before.exists) {
        return null;
    }
    const messageData = event.data.after.data();
    const chatId = event.params.chatId;
    const fromId = messageData.from;

    if (fromId === 'system') {
        return null;
    }

    const chatRef = db.doc(`artifacts/${appId}/private_chats/${chatId}`);

    try {
        await db.runTransaction(async (transaction) => {
            const chatDoc = await transaction.get(chatRef);
            let chatData = chatDoc.data() || {};

            if (chatData.lastMessageFrom !== fromId) {
                const newScore = (chatData.syncScore || 0) + 1;

                if (newScore >= 10) { // Harmony Sync Threshold
                    const reward = 5;
                    const [user1Id, user2Id] = chatId.split('_');
                    const user1Ref = db.doc(`artifacts/${appId}/public/data/user_profiles/${user1Id}`);
                    const user2Ref = db.doc(`artifacts/${appId}/public/data/user_profiles/${user2Id}`);

                    // Award tokens and increment quest counters for both users
                    transaction.update(user1Ref, { tokens: FieldValue.increment(reward), "weeklyQuestProgress.harmonySyncs": FieldValue.increment(1) });
                    transaction.update(user2Ref, { tokens: FieldValue.increment(reward), "weeklyQuestProgress.harmonySyncs": FieldValue.increment(1) });

                    const syncMessageRef = chatRef.collection('messages').doc();
                    transaction.set(syncMessageRef, {
                        from: 'system',
                        content: `Harmony Sync! Both users earned ${reward} Echoes for a great conversation.`,
                        timestamp: FieldValue.serverTimestamp(),
                        isHarmonySync: true
                    });

                    transaction.set(chatRef, { syncScore: 0, lastMessageFrom: fromId }, { merge: true });

                } else {
                    transaction.set(chatRef, { syncScore: newScore, lastMessageFrom: fromId }, { merge: true });
                }
            }
        });
    } catch (error) {
        console.error(`Error in logMessageActivity for chat ${chatId}:`, error);
    }
    return null;
});

// In index.js (Cloud Functions)

// NEW Function to create a single, dynamic AI persona
exports.createAiPersona = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Authentication is required.");

    const userProfileSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${request.auth.uid}`).get();
    if (!userProfileSnap.exists || userProfileSnap.data().role !== 'owner') {
        throw new HttpsError("permission-denied", "You do not have permission to perform this action.");
    }

    const { name, bio_prompt, interests_list } = request.data;
    if (!name || !bio_prompt || !interests_list) {
        throw new HttpsError("invalid-argument", "Name, bio prompt, and interests are required.");
    }

    try {
        const bioPrompt = `Write a short, engaging bio (under 150 characters) for a persona named "${name}" who is "${bio_prompt}". Use a casual, first-person tone.`;
        const { text: generatedBio } = await generateAiContent(bioPrompt);

        if (!generatedBio) {
            throw new HttpsError("internal", "AI failed to generate a bio for the persona.");
        }

        const aiUserId = `ai-${name.toLowerCase().replace(/\s/g, '-')}-${Date.now()}`;
        const aiUserProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${aiUserId}`);

        await aiUserProfileRef.set({
            id: aiUserId,
            displayName: name,
            photoURL: `https://api.dicebear.com/7.x/personas/svg?seed=${name.replace(/\s/g, '')}`,
            bio: generatedBio,
            interests: interests_list,
            isAI: true,
            role: 'user',
            createdAt: FieldValue.serverTimestamp(),
            // Initialize other fields to prevent errors
            tokens: 0,
            reputationScore: 50,
            vibeScore: 0,
        });

        return { success: true, message: `AI Persona "${name}" created successfully.` };
    } catch (error) {
        console.error("Error creating AI persona:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred.");
    }
});


// In index.js, add this new function.

exports.updateInfluenceOnReaction = onDocumentWritten(`artifacts/${appId}/public/data/anonymous_entries/{entryId}`, (event) => {
    // We only care about updates, not creations or deletions for this logic.
    if (!event.data.before.exists || !event.data.after.exists) {
        return null;
    }

    const before = event.data.before.data();
    const after = event.data.after.data();
    const authorId = after.authorId;

    // If the author is an AI, do not calculate influence.
    if (!authorId || after.isAI) {
        return null;
    }

    let influenceChange = 0;

    // Calculate change from likes
    const likesBefore = before.likesCount || 0;
    const likesAfter = after.likesCount || 0;
    influenceChange += (likesAfter - likesBefore) * 1; // +1 influence per like

    // Calculate change from comments
    const commentsBefore = before.commentsCount || 0;
    const commentsAfter = after.commentsCount || 0;
    influenceChange += (commentsAfter - commentsBefore) * 3; // +3 influence per comment

    // Calculate change from echoes invested
    const echoesBefore = before.echoesInvested || 0;
    const echoesAfter = after.echoesInvested || 0;
    influenceChange += (echoesAfter - echoesBefore) * 0.1; // +0.1 influence per Echo

    if (influenceChange !== 0) {
        const authorProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${authorId}`);
        return authorProfileRef.update({
            influenceScore: FieldValue.increment(influenceChange)
        }).catch(err => {
            console.error(`Failed to update influence score for user ${authorId}:`, err);
        });
    }

    return null;
});



// In index.js, REPLACE the existing updateProfilePicture function with this one.
exports.updateProfilePicture = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to update your profile picture.");
    }

    const { filePath } = request.data; // We now receive the full path from the client
    const userId = request.auth.uid;

    if (!filePath) {
        throw new HttpsError("invalid-argument", "A valid file path is required from the client.");
    }

    try {
        // --- THIS IS THE FIX (Part 1): Make the file public ---
        const bucket = getStorage().bucket();
        const file = bucket.file(filePath);
        await file.makePublic();
        // --- END OF FIX ---

        // Get the public URL, now that we know the file is public.
        const publicUrl = file.publicUrl();

        // Create the new URL with a timestamp to force browsers to reload the image.
        const newUrlWithCacheBuster = `${publicUrl}?t=${Date.now()}`;

        const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
        await userProfileRef.update({
            photoURL: newUrlWithCacheBuster
        });

        console.log(`Successfully updated profile picture for user: ${userId}`);
        return { success: true, newUrl: newUrlWithCacheBuster };

    } catch (error) {
        console.error(`Failed to update profile picture for user ${userId}:`, error);
        throw new HttpsError("internal", "Could not update the profile picture.");
    }
});

// In index.js, add this new function.

exports.setSpotlight = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to set a spotlight.");
    }

    const { whisperId } = request.data;
    const userId = request.auth.uid;
    const SPOTLIGHT_COST = 1000; // The required influence score

    if (!whisperId) {
        throw new HttpsError("invalid-argument", "A valid whisper ID is required.");
    }

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const whisperRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${whisperId}`);
    const spotlightRef = db.doc(`artifacts/${appId}/public/data/app_metadata/current_spotlight`);

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            const whisperDoc = await transaction.get(whisperRef);

            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");
            if (!whisperDoc.exists) throw new HttpsError("not-found", "The whisper you are trying to spotlight does not exist.");

            const userData = userDoc.data();
            const whisperData = whisperDoc.data();

            if (whisperData.authorId !== userId) {
                throw new HttpsError("permission-denied", "You can only spotlight your own whispers.");
            }

            if ((userData.influenceScore || 0) < SPOTLIGHT_COST) {
                throw new HttpsError("resource-exhausted", `You need at least ${SPOTLIGHT_COST} Influence to set a spotlight.`);
            }

            // Deduct the cost and set the spotlight
            transaction.update(userProfileRef, { influenceScore: FieldValue.increment(-SPOTLIGHT_COST) });
            transaction.set(spotlightRef, {
                entryId: whisperId,
                authorId: userId,
                setAt: FieldValue.serverTimestamp()
            });
        });

        return { success: true, message: "Your whisper is now in the spotlight!" };
    } catch (error) {
        console.error(`Error setting spotlight for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred while setting the spotlight.");
    }
});

// In index.js, REPLACE the existing updateLeaderboardsAndBadges function with this one.

exports.updateLeaderboardsAndBadges = onSchedule({ ...functionOptions, schedule: "every 24 hours" }, async (event) => {
    console.log("Running scheduled job: Update Leaderboards and Badges V2");
    const usersRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);
    const leaderboardRef = db.doc(`artifacts/${appId}/public/data/app_metadata/leaderboards`);

    try {
        const usersSnapshot = await usersRef.where("isAI", "==", false).get();
        if (usersSnapshot.empty) {
            console.log("No users found to process for leaderboards.");
            // Set empty leaderboards to prevent frontend errors
            await leaderboardRef.set({
                reputation: [],
                earnings: [],
                lastUpdated: FieldValue.serverTimestamp(),
            });
            return null;
        }

        const allUsers = usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const batch = db.batch();

        // --- 1. Badge Assignment Logic ---
        allUsers.forEach(user => {
            const newBadges = new Set(user.badges || []);
            const currentBadgeCount = newBadges.size;

            // Reputation Badges
            if ((user.reputationScore || 0) >= 100) newBadges.add('respected_voice');
            if ((user.reputationScore || 0) >= 500) newBadges.add('community_pillar');

            // Contribution Badges
            if ((user.totalEarnings || 0) >= 1000) newBadges.add('echo_weaver');
            if ((user.totalEarnings || 0) >= 10000) newBadges.add('echo_magnate');

            // Check if badges have changed before writing to the database
            if (newBadges.size > currentBadgeCount) {
                const userProfileRef = usersRef.doc(user.id);
                batch.update(userProfileRef, { badges: Array.from(newBadges) });
            }
        });

        // --- 2. Leaderboard Calculation Logic ---
        const topReputation = [...allUsers].sort((a, b) => (b.reputationScore || 0) - (a.reputationScore || 0)).slice(0, 10);
        const topEarners = [...allUsers].sort((a, b) => (b.totalEarnings || 0) - (a.totalEarnings || 0)).slice(0, 10);

        const leaderboardData = {
            reputation: topReputation.map(u => ({ id: u.id, displayName: u.displayName, photoURL: u.photoURL, value: u.reputationScore || 0 })),
            earnings: topEarners.map(u => ({ id: u.id, displayName: u.displayName, photoURL: u.photoURL, value: u.totalEarnings || 0 })),
            lastUpdated: FieldValue.serverTimestamp(),
        };

        batch.set(leaderboardRef, leaderboardData);

        // Commit all updates
        await batch.commit();
        console.log(`Successfully updated leaderboards and assigned badges for ${allUsers.length} users.`);
        return null;

    } catch (error) {
        console.error("CRITICAL ERROR during updateLeaderboardsAndBadges job:", error);
        // We throw the error to ensure the function reports a failure in the logs.
        throw new Error(`Leaderboard and badge update failed: ${error.message}`);
    }
});
// NEW Function to delete an AI persona
exports.deleteAiPersona = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Authentication is required.");

    const userProfileSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${request.auth.uid}`).get();
    if (!userProfileSnap.exists || userProfileSnap.data().role !== 'owner') {
        throw new HttpsError("permission-denied", "You do not have permission to perform this action.");
    }

    const { aiUserId } = request.data;
    if (!aiUserId || !aiUserId.startsWith('ai-')) {
        throw new HttpsError("invalid-argument", "A valid AI user ID is required.");
    }

    try {
        const aiUserProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${aiUserId}`);
        await aiUserProfileRef.delete();
        return { success: true, message: "AI Persona deleted successfully." };
    } catch (error) {
        console.error("Error deleting AI persona:", error);
        throw new HttpsError("internal", "Could not delete the AI persona.");
    }
});
// In index.js, add this entire new function.

exports.proactiveSentimentCheck = onSchedule({ ...functionOptions, schedule: "every 4 hours" }, async (event) => {
    console.log("Running scheduled job: Proactive Sentiment Check");
    const usersRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);
    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    try {
        const usersSnapshot = await usersRef.where("isAI", "==", false).get();
        if (usersSnapshot.empty) return null;

        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const recentWhispersQuery = whispersRef
                .where("authorId", "==", userId)
                .where("timestamp", ">=", sevenDaysAgo)
                .orderBy("timestamp", "desc")
                .limit(15);

            const whispersSnapshot = await recentWhispersQuery.get();

            // Only analyze if there's a meaningful number of recent whispers
            if (whispersSnapshot.docs.length < 5) {
                continue;
            }

            const whispersText = whispersSnapshot.docs.map(doc => doc.data().content).join("\n---\n");

            const prompt = `Analyze the sentiment of the following user whispers. Determine if there is a strong, persistent negative theme. Respond ONLY with a valid JSON object with this structure: {"checkInNeeded": boolean, "theme": "string"}.
            - "checkInNeeded" should be true ONLY if themes like loneliness, high stress, anxiety, or deep sadness are consistently present.
            - "theme" should be a single word summarizing the dominant negative emotion (e.g., "stress", "loneliness", "frustration", "sadness") or "neutral" if not needed.
            Whispers: "${whispersText}"`;

            const { text: jsonResponse } = await generateAiContent(prompt);

            try {
                const analysis = JSON.parse(jsonResponse);

                if (analysis.checkInNeeded) {
                    let suggestionMessage = "";
                    let suggestionType = "AURA_SCAN"; // Default suggestion

                    // Generate a tailored suggestion based on the theme
                    switch (analysis.theme) {
                        case "loneliness":
                            suggestionMessage = "It seems like connection is on your mind. Remember, you're a valued part of this cosmos.";
                            suggestionType = "CONNECT_FRIEND";
                            break;
                        case "stress":
                        case "anxiety":
                            suggestionMessage = "It sounds like things have been intense lately. Taking a moment to reflect can sometimes help center your thoughts.";
                            suggestionType = "AURA_SCAN";
                            break;
                        default:
                            suggestionMessage = "We've noticed you've been sharing some deep thoughts. Sometimes, just talking it out can help lighten the load.";
                            suggestionType = "TALK_TO_LISTENER";
                            break;
                    }

                    const suggestionRef = db.doc(`artifacts/${appId}/users/${userId}/suggestions/active-suggestion`);
                    await suggestionRef.set({
                        message: suggestionMessage,
                        type: suggestionType,
                        theme: analysis.theme,
                        createdAt: FieldValue.serverTimestamp(),
                    });
                    console.log(`Generated a proactive suggestion for user ${userId} with theme: ${analysis.theme}`);
                }
            } catch (e) {
                console.error(`Failed to parse AI response for user ${userId}:`, jsonResponse, e);
            }
        }
        console.log("Proactive Sentiment Check job completed.");
        return null;
    } catch (error) {
        console.error("Error during proactiveSentimentCheck job:", error);
        return null;
    }
});
exports.getAuraInsight = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const userId = request.auth.uid;
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        const userDoc = await userProfileRef.get();
        if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");

        const userData = userDoc.data();
        const isPro = userData.proStatus === 'active';
        const freeScansUsed = userData.freeAuraScansUsed || 0;

        if (!isPro && freeScansUsed >= 1) {
            throw new HttpsError("permission-denied", "Unlock unlimited Aura Scans with Harmony Pro!");
        }

        const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
        // ... (rest of the AI logic is the same)
        const q = whispersRef.where("authorId", "==", userId).orderBy("timestamp", "desc").limit(15);
        const snapshot = await q.get();

        if (snapshot.docs.length < 3) {
            return {
                mood: "Mysterious",
                color: "#808080", // Gray
                colorName: "Unseen Mist",
                themes: ["Not enough data"],
                affirmation: "Share more of your thoughts to reveal the color of your aura."
            };
        }

        const whispersText = snapshot.docs.map(doc => doc.data().content).join("\n---\n");
        const prompt = `Analyze the following journal entries. Return a JSON object with this exact structure: {"mood": "...", "color": "HEX code", "colorName": "Creative Name", "themes": ["Theme 1", "Theme 2"], "affirmation": "..."}. 
        - "mood" must be one of: Positive, Negative, Neutral, Reflective, Ambitious, Content.
        - "color" must be a hex color code representing the mood.
        - "colorName" must be a creative, 2-word name for the color (e.g., "Electric Gold", "Deep Ocean").
        - "themes" must be an array of 2-3 key topics or feelings from the text.
        - "affirmation" must be a short, encouraging sentence based on the themes.
        Entries: "${whispersText}"`;

        const { text: jsonResponse } = await generateAiContent(prompt);

        if (!isPro) {
            await userProfileRef.update({ freeAuraScansUsed: FieldValue.increment(1) });
        }

        const result = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, ''));
        return result;

    } catch (error) {
        console.error(`Error in getAuraInsight for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not analyze your aura at this time.");
    }
});
// In index.js, REPLACE the existing deleteOldMessages function.
exports.deleteOldMessages = onSchedule({ ...functionOptions, schedule: "every 24 hours" }, async (event) => {
    console.log("Running scheduled job: deleteOldMessages");

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oldMessagesQuery = db.collectionGroup('messages').where('timestamp', '<=', sevenDaysAgo);

    try {
        const snapshot = await oldMessagesQuery.get();
        if (snapshot.empty) {
            console.log("No old messages to delete.");
            return null;
        }

        const batch = db.batch();
        snapshot.forEach(doc => {
            // This now deletes the document itself, and Firestore handles subcollections if any were added.
            // For this app, reactions are a map, so this is sufficient.
            batch.delete(doc.ref);
        });

        await batch.commit();
        console.log(`Successfully deleted ${snapshot.size} old messages.`);
        return null;

    } catch (error) {
        console.error("Error during deleteOldMessages job:", error);
        return null;
    }
});

// In index.js, REPLACE the existing addStarToConstellation function with this one.
exports.addStarToConstellation = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to add to a constellation.");
    }

    const { parentWhisperId, content, tags } = request.data;
    const userId = request.auth.uid;

    if (!parentWhisperId || !content) {
        throw new HttpsError("invalid-argument", "A parent whisper and content are required.");
    }

    const costToAddStar = 5;
    const seedRoyalty = 1;

    const userProfileRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(userId);
    const parentWhisperRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).doc(parentWhisperId);

    try {
        const bonusChance = Math.random();
        let echoBonus = 0;
        if (bonusChance > 0.5) {
            echoBonus = Math.floor(Math.random() * 10) + 1;
        }

        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            const parentWhisperDoc = await transaction.get(parentWhisperRef);

            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");
            if (!parentWhisperDoc.exists) throw new HttpsError("not-found", "The whisper you are connecting to does not exist.");

            const userData = userDoc.data();
            const parentWhisperData = parentWhisperDoc.data();

            if (userData.tokens < costToAddStar) {
                throw new HttpsError("resource-exhausted", `You need ${costToAddStar} Echoes to add a star.`);
            }

            const constellationId = parentWhisperData.constellationId || parentWhisperId;
            const seedWhisperDoc = await transaction.get(db.collection(`artifacts/${appId}/public/data/anonymous_entries`).doc(constellationId));
            const seedAuthorId = seedWhisperDoc.data().authorId;

            if (seedAuthorId && seedAuthorId !== userId) {
                const seedAuthorRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(seedAuthorId);
                transaction.update(seedAuthorRef, { tokens: FieldValue.increment(seedRoyalty) });
            }

            const netCost = costToAddStar - echoBonus;
            // SECURE QUEST COUNTER
            transaction.update(userProfileRef, {
                tokens: FieldValue.increment(-netCost),
                "dailyQuestProgress.starsAdded": FieldValue.increment(1)
            });

            const newStarRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).doc();
            transaction.set(newStarRef, {
                authorId: userId, authorName: 'Anonymous', content: content,
                tags: tags || [], timestamp: FieldValue.serverTimestamp(), isAnonymous: true, isSeed: false,
                constellationId: constellationId, parentWhisperId: parentWhisperId,
                likes: [], dislikes: [], likesCount: 0, dislikesCount: 0, echoesInvested: 0,
                amplifiedBy: [], trendingScore: 0,
            });
        });

        return { success: true, bonus: echoBonus, message: "Star added to the Constellation!" };

    } catch (error) {
        console.error("Error adding star to constellation:", error);
        throw new HttpsError("internal", error.message || "An unknown error occurred.");
    }
});
// CORRECTED & OPTIMIZED AI User Initialization Function
exports.initializeAIUsers = onCall({ ...functionOptions, memory: "1GiB" }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const userProfileSnap = await db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(request.auth.uid).get();
    if (!userProfileSnap.exists || userProfileSnap.data().role !== 'owner') {
        throw new HttpsError("permission-denied", "You do not have permission to perform this action.");
    }

    const aiUsersData = [
        { name: "Chill Vibes", bio_prompt: "Just here to share good vibes and keep things positive.", interests_list: ["music", "nature walks", "simple living"], event_reaction_style: "relaxed and optimistic" },
        { name: "Gadget Guy", bio_prompt: "Always checking out the newest tech and how it changes stuff.", interests_list: ["new phones", "gaming gear", "smart homes"], event_reaction_style: "curious and practical" },
        { name: "Creative Soul", bio_prompt: "Love making art and seeing what inspires people.", interests_list: ["drawing", "writing stories", "cool designs"], event_reaction_style: "imaginative and appreciative" },
        { name: "Daily Drama", bio_prompt: "Can't help but keep up with all the celebrity gossip and social media buzz.", interests_list: ["pop culture", "fashion fails", "viral trends"], event_reaction_style: "sarcastic and opinionated" },
        { name: "Green Thumb", bio_prompt: "Into gardening and anything that helps the planet.", interests_list: ["plants", "recycling", "hiking"], event_reaction_style: "caring and hopeful" },
        { name: "Gym Rat", bio_prompt: "Working out is my jam, always pushing for healthier habits.", interests_list: ["lifting", "running", "healthy food"], event_reaction_style: "energetic and motivating" },
        { name: "Foodie Friend", bio_prompt: "Exploring all kinds of food, from fancy dinners to street tacos.", interests_list: ["cooking", "restaurants", "baking"], event_reaction_style: "enthusiastic and descriptive" },
        { name: "History Hound", bio_prompt: "Fascinated by old stories and how they connect to today.", interests_list: ["ancient times", "famous people", "museums"], event_reaction_style: "thoughtful and insightful" },
        { name: "Gamer Pro", bio_prompt: "Spending my free time in virtual worlds, always looking for a new challenge.", interests_list: ["video games", "online multiplayer", "esports"], event_reaction_style: "competitive and strategic" },
        { name: "Book Nook", bio_prompt: "Always got my nose in a book, love getting lost in a good story.", interests_list: ["fantasy novels", "sci-fi", "true crime"], event_reaction_style: "quiet and reflective" },
    ];

    console.log(`Owner ${request.auth.uid} initiated AI User initialization.`);

    // Single prompt for batch generation
    const batchPrompt = `For each of the following personas, write a short, engaging bio (under 150 characters) using high school level vocabulary, sounding like a regular American. Return the result as a valid JSON array of strings, where each string is a bio.

Personas:
${aiUsersData.map(p => `- ${p.name}: ${p.bio_prompt}`).join('\n')}

JSON Array:`;

    const { text: generatedBiosJson } = await generateAiContent(batchPrompt);
    let generatedBios = [];
    try {
        generatedBios = JSON.parse(generatedBiosJson);
        if (generatedBios.length !== aiUsersData.length) throw new Error("Mismatched bio count");
    } catch (e) {
        console.error("Failed to parse bios JSON from AI. Falling back to individual generation.", e);
        // Fallback can be implemented here if needed, but for now we'll rely on the robust single call.
        throw new HttpsError("internal", "Failed to generate AI bios as a batch.");
    }

    const batch = db.batch();
    aiUsersData.forEach((aiUserData, index) => {
        const aiUserId = `ai-${aiUserData.name.toLowerCase().replace(/\s/g, '-')}`;
        const aiUserProfileRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(aiUserId);
        const profileData = {
            id: aiUserId,
            displayName: aiUserData.name,
            photoURL: `https://api.dicebear.com/7.x/personas/svg?seed=${aiUserData.name.replace(/\s/g, '')}`,
            bio: generatedBios[index] || aiUserData.bio_prompt, // Fallback to prompt if bio is missing
            interests: aiUserData.interests_list,
            location: 'AI-World',
            isAI: true,
            role: 'user',
            balance: 0, earnings: 0, likesCount: 0, dislikesCount: 0, imageGallery: [], createdAt: FieldValue.serverTimestamp(),
            completedQuests: [], engagementPoints: 0, tokens: 0, lastDailyBonusClaim: null,
        };
        batch.set(aiUserProfileRef, profileData, { merge: true });
    });

    await batch.commit();
    console.log("AI user profiles have been successfully created/updated.");
    return { success: true, message: `${aiUsersData.length} AI users initialized successfully.` };
});

// --- THIS IS THE FIX (Part 2): Refactored onCall Function ---
// This function now calls the internal helper, keeping the endpoint consistent.
exports.moderateContent = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }
    const { text } = request.data;
    if (!text) {
        throw new HttpsError("invalid-argument", "Valid text is required.");
    }

    return await _moderateContentHelper(text);
});

// In index.js, REPLACE the entire claimQuestReward function with this one.

exports.claimQuestReward = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const { questId } = request.data;
    const userId = request.auth.uid;

    if (!questId || !questDefinitions[questId]) {
        throw new HttpsError("invalid-argument", "A valid quest ID is required.");
    }

    const quest = questDefinitions[questId];
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        const result = await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile not found.");

            const userData = userDoc.data();
            const completedQuests = userData.completedQuests || {};

            // Universal Cooldown/Completion Check
            if (completedQuests[questId]) {
                const lastCompleted = completedQuests[questId].toDate();
                if (quest.type === 'onboarding' || quest.type === 'milestone' || quest.type === 'monthly' || quest.type === 'annual') {
                    throw new HttpsError("already-exists", "This quest has already been completed.");
                }
                let cooldown = 0;
                if (quest.type === 'daily') cooldown = 22 * 60 * 60 * 1000; // 22 hours
                if (quest.type === 'weekly') cooldown = 6.5 * 24 * 60 * 60 * 1000; // 6.5 days
                if (Date.now() - lastCompleted.getTime() < cooldown) {
                    throw new HttpsError("failed-precondition", "This quest is still on cooldown.");
                }
            }

            let isComplete = false;
            const daily = userData.dailyQuestProgress || {};
            const weekly = userData.weeklyQuestProgress || {};
            const monthly = userData.monthlyQuestProgress || {};
            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));

            // Server-Side Verification Logic
            switch (questId) {
                // Onboarding & Milestones (State-based, some async)
                case 'customize_profile': isComplete = !!(userData.bio || userData.interests?.length > 0); break;
                case 'like_three_whispers': isComplete = (userData.likesGiven || 0) >= 3; break;
                case 'follow_a_user': isComplete = (userData.followingCount || 0) >= 1; break;
                case 'reach_100_reputation': isComplete = (userData.reputationScore || 0) >= 100; break;
                case 'reach_500_reputation': isComplete = (userData.reputationScore || 0) >= 500; break;
                case 'reach_1000_reputation': isComplete = (userData.reputationScore || 0) >= 1000; break;

                // Dailies (Counter-based)
                case 'daily_login': isComplete = true; break; // Claimed just by calling
                case 'amplify_whisper_daily': isComplete = (daily.amplifies || 0) >= 1; break;
                case 'add_star_daily': isComplete = (daily.starsAdded || 0) >= 1; break;
                case 'post_whisper_daily': isComplete = (daily.posts || 0) >= 1; break;
                case 'send_three_messages_daily': isComplete = (daily.messagesSent || 0) >= 3; break;
                case 'open_echo_chamber_daily': isComplete = (daily.echoChambersOpened || 0) >= 1; break;
                case 'react_to_five_comments_daily': isComplete = (daily.reactions || 0) >= 5; break;
                case 'generate_ai_prompt_daily': isComplete = (daily.promptsGenerated || 0) >= 1; break;

                // Weeklies (Counter-based)
                case 'post_three_whispers_weekly': isComplete = (weekly.posts || 0) >= 3; break;
                case 'receive_five_amplifications_weekly': isComplete = (weekly.amplificationsReceived || 0) >= 5; break;
                case 'connect_with_three_users_weekly': isComplete = (weekly.connectionsMade || 0) >= 3; break;
                case 'spend_100_echoes_weekly': isComplete = (weekly.echoesSpent || 0) >= 100; break;
                case 'earn_50_reputation_weekly': isComplete = ((userData.reputationScore || 0) - (weekly.startReputation || userData.reputationScore)) >= 50; break;
                case 'start_constellation_weekly': isComplete = (weekly.constellationsStarted || 0) >= 1; break;
                case 'get_harmony_sync_weekly': isComplete = (weekly.harmonySyncs || 0) >= 1; break;

                // Monthlies (State/Counter-based)
                case 'post_20_whispers_monthly': isComplete = (monthly.posts || 0) >= 20; break;
                case 'maintain_positive_vibe_monthly': isComplete = (userData.vibeScore || 0) > 50; break;
                case 'amplify_10_whispers_monthly': isComplete = (monthly.amplifies || 0) >= 10; break;

                // Meta Quests (Logic based on other completed quests)
                case 'complete_three_daily_quests':
                    const completedDailies = Object.keys(completedQuests).filter(id => {
                        const qDef = questDefinitions[id];
                        return qDef && qDef.type === 'daily' && completedQuests[id].toDate() > startOfDay;
                    });
                    isComplete = completedDailies.length >= 3;
                    break;
                case 'complete_three_weekly_quests':
                    const completedWeeklies = Object.keys(completedQuests).filter(id => {
                        const qDef = questDefinitions[id];
                        return qDef && qDef.type === 'weekly' && completedQuests[id].toDate() > startOfWeek;
                    });
                    isComplete = completedWeeklies.length >= 3;
                    break;

                default: isComplete = false; // Default to false for async checks below
            }

            // Async verifications for quests that require a separate, non-transactional query
            if (['post_first_whisper', 'seal_first_whisper', 'echo_first_whisper', 'join_a_nexus'].includes(questId)) {
                let q;
                if (questId === 'post_first_whisper') q = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).where("authorId", "==", userId).limit(1);
                if (questId === 'seal_first_whisper') q = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).where("authorId", "==", userId).where("isSealed", "==", true).limit(1);
                if (questId === 'echo_first_whisper') q = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).where("authorId", "==", userId).where("isEcho", "==", true).limit(1);
                if (questId === 'join_a_nexus') q = db.collection(`artifacts/${appId}/public/data/nexuses`).where("memberIds", "array-contains", userId).limit(1);
                const snap = await q.get();
                isComplete = !snap.empty;
            }

            if (!isComplete) throw new HttpsError("failed-precondition", "You have not met the requirements for this quest.");

            // Award & Update
            transaction.update(userProfileRef, {
                tokens: FieldValue.increment(quest.reward),
                [`completedQuests.${questId}`]: FieldValue.serverTimestamp()
            });
            return { success: true, reward: quest.reward };
        });
        return result;
    } catch (error) {
        console.error(`Error claiming quest ${questId} for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unknown error occurred while claiming your reward.");
    }
});

// In index.js, add this entire new scheduled function.

exports.deleteOldWhispers = onSchedule({ ...functionOptions, schedule: "every 1 hours" }, async (event) => {
    console.log("Running scheduled job: deleteOldWhispers");

    const now = Date.now();
    const seventyTwoHoursAgo = new Date(now - 72 * 60 * 60 * 1000);

    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const oldWhispersQuery = whispersRef.where('timestamp', '<=', seventyTwoHoursAgo);

    try {
        const snapshot = await oldWhispersQuery.get();
        if (snapshot.empty) {
            console.log("No old whispers found to delete.");
            return null;
        }

        // Use batched writes to delete documents efficiently and avoid overwhelming the system.
        // Firestore batches can hold up to 500 operations.
        const batchSize = 490;
        let batch = db.batch();
        let count = 0;

        snapshot.forEach(doc => {
            batch.delete(doc.ref);
            count++;
            if (count === batchSize) {
                // Commit the batch and start a new one
                batch.commit();
                batch = db.batch();
                count = 0;
            }
        });

        // Commit any remaining documents in the last batch.
        if (count > 0) {
            await batch.commit();
        }

        console.log(`Successfully deleted ${snapshot.size} old whispers.`);
        return null;

    } catch (error) {
        console.error("Error during deleteOldWhispers job:", error);
        return null;
    }
});
// In index.js, REPLACE the existing createNexus function with this one.
exports.createNexus = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to create a Nexus.");
    }

    const { name, description, privacy, color } = request.data;
    const userId = request.auth.uid;
    const NEXUS_CREATION_COST = 500;

    if (!name || !description || !privacy) {
        throw new HttpsError("invalid-argument", "A name, description, and privacy setting are required.");
    }

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const ownerId = await getOwnerAccountId();
    const nexusRef = db.collection(`artifacts/${appId}/public/data/nexuses`).doc();

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");
            if ((userDoc.data().tokens || 0) < NEXUS_CREATION_COST) {
                throw new HttpsError("resource-exhausted", `You need ${NEXUS_CREATION_COST} Echoes to forge a Nexus.`);
            }

            transaction.update(userProfileRef, { tokens: FieldValue.increment(-NEXUS_CREATION_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(NEXUS_CREATION_COST) });
            }

            transaction.set(nexusRef, {
                id: nexusRef.id, // --- BEST PRACTICE FIX ---
                name: name,
                description: description,
                privacy: privacy,
                nexusColor: color || '#FFFFFF',
                coverImageURL: `https://api.dicebear.com/7.x/shapes/svg?seed=${name.replace(/\s/g, '')}`,
                ownerId: userId,
                moderatorIds: [userId],
                memberIds: [userId],
                memberCount: 1,
                createdAt: FieldValue.serverTimestamp(),
                level: 1,
                luminance: 0,
                luminanceToNextLevel: 100,
            });

            const memberRef = nexusRef.collection('members').doc(userId);
            transaction.set(memberRef, {
                role: 'owner',
                joinedAt: FieldValue.serverTimestamp()
            });
        });

        return { success: true, nexusId: nexusRef.id, message: "Your Nexus has been forged!" };

    } catch (error) {
        console.error(`Error creating Nexus for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred while forging your Nexus.");
    }
});


// In index.js, REPLACE the existing joinNexus function.
exports.joinNexus = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
    const { nexusId } = request.data;
    const userId = request.auth.uid;

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const memberRef = nexusRef.collection('members').doc(userId);

    try {
        await db.runTransaction(async (transaction) => {
            const nexusDoc = await transaction.get(nexusRef);
            if (!nexusDoc.exists) throw new HttpsError("not-found", "This Nexus does not exist.");
            if (nexusDoc.data().privacy !== 'public') throw new HttpsError("permission-denied", "This Nexus is private and requires an invitation.");

            const memberDoc = await transaction.get(memberRef);
            if (memberDoc.exists) throw new HttpsError("already-exists", "You are already a member of this Nexus.");

            transaction.set(memberRef, { role: 'member', joinedAt: FieldValue.serverTimestamp() });
            transaction.update(nexusRef, {
                memberCount: FieldValue.increment(1),
                memberIds: FieldValue.arrayUnion(userId) // <-- THE FIX
            });
        });
        return { success: true };
    } catch (error) {
        console.error(`Error joining Nexus ${nexusId} for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not join the Nexus.");
    }
});

// In index.js, REPLACE the existing leaveNexus function.
exports.leaveNexus = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
    const { nexusId } = request.data;
    const userId = request.auth.uid;

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const memberRef = nexusRef.collection('members').doc(userId);

    try {
        await db.runTransaction(async (transaction) => {
            const nexusDoc = await transaction.get(nexusRef);
            if (!nexusDoc.exists) throw new HttpsError("not-found", "This Nexus does not exist.");
            if (nexusDoc.data().ownerId === userId) throw new HttpsError("failed-precondition", "The owner cannot leave the Nexus. You must transfer ownership or delete it.");

            const memberDoc = await transaction.get(memberRef);
            if (!memberDoc.exists) throw new HttpsError("not-found", "You are not a member of this Nexus.");

            transaction.delete(memberRef);
            transaction.update(nexusRef, {
                memberCount: FieldValue.increment(-1),
                memberIds: FieldValue.arrayRemove(userId) // <-- THE FIX
            });
        });
        return { success: true };
    } catch (error) {
        console.error(`Error leaving Nexus ${nexusId} for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not leave the Nexus.");
    }
});

/**
 * Calculates luminance gains and determines if a level-up occurs.
 * This is a pure helper function to be used inside database transactions.
 * @param {object} nexusData The current data of the Nexus document.
 * @param {number} amount The amount of luminance to add.
 * @returns {object} An object with the fields to update in Firestore.
 */
const _calculateLevelUp = (nexusData, amount) => {
    const currentLuminance = nexusData.luminance || 0;
    const newTotalLuminance = currentLuminance + amount;

    if (newTotalLuminance >= nexusData.luminanceToNextLevel) {
        // LEVEL UP!
        const newLevel = (nexusData.level || 1) + 1;
        const remainingLuminance = newTotalLuminance - nexusData.luminanceToNextLevel;
        // A steeper curve for higher levels
        const nextLevelThreshold = Math.floor(100 * Math.pow(newLevel, 1.5));

        return {
            level: newLevel,
            luminance: remainingLuminance,
            luminanceToNextLevel: nextLevelThreshold,
            leveledUp: true // Flag to indicate a level up occurred
        };
    } else {
        // Just increment luminance
        return {
            luminance: FieldValue.increment(amount),
            leveledUp: false
        };
    }
};

/**
 * Updates a Nexus's luminance and handles level-ups in a dedicated transaction.
 * @param {string} nexusId The ID of the nexus to update.
 * @param {number} amount The amount of luminance to add.
 */
const handleLuminanceUpdate = async (nexusId, amount) => {
    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    try {
        await db.runTransaction(async (transaction) => {
            const nexusDoc = await transaction.get(nexusRef);
            if (!nexusDoc.exists) return;

            const updateData = _calculateLevelUp(nexusDoc.data(), amount);
            // Remove the helper flag before writing to Firestore
            delete updateData.leveledUp;

            transaction.update(nexusRef, updateData);
        });
    } catch (error) {
        console.error(`Failed to update luminance for Nexus ${nexusId}:`, error);
    }
};

// In index.js, add this entire new scheduled function.
exports.resetDailyQuestProgress = onSchedule({ ...functionOptions, schedule: "every day 00:00", timeZone: "America/New_York" }, async (event) => {
    console.log("Running scheduled job: resetDailyQuestProgress");
    const usersRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);
    const snapshot = await usersRef.where("isAI", "==", false).get();

    if (snapshot.empty) {
        console.log("No users found to reset daily quest progress.");
        return null;
    }

    const batch = db.batch();
    const dailyResetFields = {
        "dailyQuestProgress.amplifies": 0,
        "dailyQuestProgress.starsAdded": 0,
        "dailyQuestProgress.echoChambersOpened": 0,
    };

    snapshot.forEach(doc => {
        const userRef = usersRef.doc(doc.id);
        batch.update(userRef, dailyResetFields);
    });

    await batch.commit();
    console.log(`Reset daily quest progress for ${snapshot.size} users.`);
    return null;
});
// In index.js, REPLACE the existing getNexusHubData function with this one.
exports.getNexusHubData = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to view a Nexus.");
    }
    const { nexusId } = request.data;
    const userId = request.auth.uid;

    if (!nexusId) {
        throw new HttpsError("invalid-argument", "A Nexus ID is required.");
    }

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);

    try {
        const nexusDoc = await nexusRef.get();
        if (!nexusDoc.exists) {
            throw new HttpsError("not-found", "The requested Nexus could not be found.");
        }

        const nexusData = nexusDoc.data();

        // Check for private nexus permissions
        if (nexusData.privacy === 'private') {
            const memberDoc = await nexusRef.collection('members').doc(userId).get();
            if (!memberDoc.exists) {
                throw new HttpsError("permission-denied", "You do not have permission to view this private Nexus.");
            }
        }

        const [postsSnapshot, membersSnapshot, chatSnapshot, questsDoc] = await Promise.all([
            nexusRef.collection('posts').orderBy('timestamp', 'desc').limit(20).get(),
            nexusRef.collection('members').get(),
            nexusRef.collection('chat').orderBy('timestamp', 'desc').limit(50).get(),
            nexusRef.collection('metadata').doc('active_quests').get()
        ]);

        const posts = postsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const members = membersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const chat = chatSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse();

        // --- THIS IS THE FIX: Changed from questsDoc.exists() to questsDoc.exists ---
        const activeQuests = questsDoc.exists ? questsDoc.data().quests : {};

        return {
            nexusData: { id: nexusDoc.id, ...nexusData },
            posts,
            members,
            chat,
            activeQuests
        };

    } catch (error) {
        console.error(`Error fetching data for Nexus ${nexusId} by user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred while fetching Nexus data.");
    }
});
// In index.js, REPLACE the existing updateNexusLeaderboards function.
exports.updateNexusLeaderboards = onSchedule({ ...functionOptions, schedule: "every monday 04:00", timeZone: "America/New_York" }, async (event) => {
    console.log("Running scheduled job: updateNexusLeaderboards");
    const nexusesRef = db.collection(`artifacts/${appId}/public/data/nexuses`);
    const leaderboardRef = db.doc(`artifacts/${appId}/public/data/app_metadata/nexus_leaderboards`);

    try {
        const snapshot = await nexusesRef.get();
        if (snapshot.empty) {
            console.log("No nexuses found to rank.");
            await leaderboardRef.set({ lastUpdated: FieldValue.serverTimestamp(), by_level: [], by_luminance_gained: [] });
            return null;
        }

        const allNexuses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const batch = db.batch();

        // --- IDEMPOTENCY FIX ---
        // Calculate gains based on the stored `lastWeekLuminance` value, which is only updated *after* a successful run.
        const nexusesWithGains = allNexuses.map(nexus => {
            const lastWeekLuminance = nexus.lastWeekLuminance || 0;
            const luminanceGained = (nexus.luminance || 0) - lastWeekLuminance;
            return { ...nexus, luminanceGained };
        });

        const topByLevel = [...allNexuses].sort((a, b) => (b.level || 0) - (a.level || 0)).slice(0, 10);
        const topByLuminanceGained = [...nexusesWithGains].sort((a, b) => b.luminanceGained - a.luminanceGained).slice(0, 10);

        const format = (nexus, value) => ({
            id: nexus.id, name: nexus.name, coverImageURL: nexus.coverImageURL,
            nexusColor: nexus.nexusColor, value: value,
        });

        const leaderboardData = {
            by_level: topByLevel.map(n => format(n, n.level)),
            by_luminance_gained: topByLuminanceGained.map(n => format(n, n.luminanceGained)),
            lastUpdated: FieldValue.serverTimestamp(),
        };

        batch.set(leaderboardRef, leaderboardData);

        // Update the snapshot value for the *next* run. This makes the job idempotent.
        allNexuses.forEach(nexus => {
            const nexusRef = nexusesRef.doc(nexus.id);
            batch.update(nexusRef, { lastWeekLuminance: nexus.luminance || 0 });
        });

        await batch.commit();
        console.log(`Successfully updated Nexus leaderboards and reset weekly stats for ${allNexuses.length} nexuses.`);
        return null;

    } catch (error) {
        console.error("CRITICAL ERROR during updateNexusLeaderboards job:", error);
        throw new Error(`Nexus leaderboard update failed: ${error.message}`);
    }
});


// In index.js, add this entire new callable function for member management.
// In index.js, add this entire new callable function for member management.
exports.manageNexusMembers = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Authentication is required.");

    const { nexusId, targetUserId, action } = request.data; // actions: 'promote', 'demote', 'kick'
    const callerId = request.auth.uid;

    if (!nexusId || !targetUserId || !action) {
        throw new HttpsError("invalid-argument", "Nexus ID, Target User ID, and Action are required.");
    }
    if (callerId === targetUserId) {
        throw new HttpsError("failed-precondition", "You cannot manage yourself.");
    }

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const callerMemberRef = nexusRef.collection('members').doc(callerId);
    const targetMemberRef = nexusRef.collection('members').doc(targetUserId);

    try {
        await db.runTransaction(async (transaction) => {
            const [nexusDoc, callerMemberDoc, targetMemberDoc] = await Promise.all([
                transaction.get(nexusRef),
                transaction.get(callerMemberRef),
                transaction.get(targetMemberRef)
            ]);

            if (!nexusDoc.exists) throw new HttpsError("not-found", "Nexus not found.");
            if (!callerMemberDoc.exists) throw new HttpsError("permission-denied", "You are not a member of this Nexus.");
            if (!targetMemberDoc.exists) throw new HttpsError("not-found", "The target user is not a member of this Nexus.");

            const nexusData = nexusDoc.data();
            const callerRole = callerMemberDoc.data().role;
            const targetRole = targetMemberDoc.data().role;

            // Rigorous Permission Checks
            const isOwner = nexusData.ownerId === callerId;
            const isModerator = callerRole === 'moderator';

            if (!isOwner && !isModerator) {
                throw new HttpsError("permission-denied", "You do not have permission to manage members.");
            }
            if (targetRole === 'owner') {
                throw new HttpsError("permission-denied", "You cannot manage the owner of the Nexus.");
            }
            if (isModerator && targetRole === 'moderator') {
                throw new HttpsError("permission-denied", "Moderators cannot manage other moderators.");
            }

            // Perform Action
            switch (action) {
                case 'promote':
                    if (!isOwner) throw new HttpsError("permission-denied", "Only the owner can promote members to moderator.");
                    transaction.update(targetMemberRef, { role: 'moderator' });
                    transaction.update(nexusRef, { moderatorIds: FieldValue.arrayUnion(targetUserId) });
                    break;
                case 'demote':
                    if (!isOwner) throw new HttpsError("permission-denied", "Only the owner can demote moderators.");
                    transaction.update(targetMemberRef, { role: 'member' });
                    transaction.update(nexusRef, { moderatorIds: FieldValue.arrayRemove(targetUserId) });
                    break;
                case 'kick':
                    transaction.delete(targetMemberRef);
                    transaction.update(nexusRef, {
                        memberCount: FieldValue.increment(-1),
                        memberIds: FieldValue.arrayRemove(targetUserId),
                        moderatorIds: FieldValue.arrayRemove(targetUserId) // Also remove from mods if they were one
                    });
                    break;
                default:
                    throw new HttpsError("invalid-argument", "Invalid action specified.");
            }
        });

        return { success: true, message: `Action '${action}' completed successfully.` };
    } catch (error) {
        console.error(`Error managing member ${targetUserId} in Nexus ${nexusId} by ${callerId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred.");
    }
});

// In index.js, add this entire new function for deleting nexuses.
exports.deleteNexus = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Authentication is required.");
    const { nexusId } = request.data;
    const callerId = request.auth.uid;

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const nexusDoc = await nexusRef.get();

    if (!nexusDoc.exists) throw new HttpsError("not-found", "Nexus not found.");
    if (nexusDoc.data().ownerId !== callerId) {
        throw new HttpsError("permission-denied", "Only the owner can delete this Nexus.");
    }

    const collections = ['posts', 'members', 'chat', 'projects', 'metadata'];
    for (const collectionName of collections) {
        const collectionRef = nexusRef.collection(collectionName);
        const snapshot = await collectionRef.limit(500).get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
    }

    await nexusRef.delete();
    return { success: true, message: "Nexus and all its content have been deleted." };
});
// In index.js, REPLACE the existing invokeAiEmissary function with this one.

exports.invokeAiEmissary = onDocumentWritten(`artifacts/${appId}/public/data/nexuses/{nexusId}/chat/{messageId}`, async (event) => {
    if (!event.data.after.exists || event.data.before.exists) return null;

    const messageData = event.data.after.data();
    const nexusId = event.params.nexusId;
    const authorId = messageData.from;

    if (!messageData.content || !messageData.content.toLowerCase().startsWith('@emissary')) {
        return null;
    }

    console.log(`AI Emissary invoked in Nexus ${nexusId} by user ${authorId}.`);

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const chatCollectionRef = nexusRef.collection('chat');
    const EMISSARY_COST = 10;

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${authorId}`);
    const ownerId = await getOwnerAccountId();

    try {
        // Step 1: Securely handle the economic transaction
        const userDoc = await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(userProfileRef);
            if (!doc.exists) throw new HttpsError("not-found", "Invoker profile not found.");
            if ((doc.data().tokens || 0) < EMISSARY_COST) {
                throw new HttpsError("resource-exhausted", `You need ${EMISSARY_COST} Echoes to invoke the Emissary.`);
            }

            transaction.update(userProfileRef, { tokens: FieldValue.increment(-EMISSARY_COST) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(EMISSARY_COST) });
            }
            return doc;
        });
        const userData = userDoc.data();

        // Step 2: Gather all necessary context for the AI
        const nexusDoc = await nexusRef.get();
        const nexusData = nexusDoc.data();

        const recentMessagesQuery = chatCollectionRef.orderBy('timestamp', 'desc').limit(20);
        const messagesSnapshot = await recentMessagesQuery.get();
        const recentChatHistory = messagesSnapshot.docs.map(doc => `${doc.data().from}: ${doc.data().content}`).reverse().join('\n');

        const userCommand = messageData.content.replace(/@emissary/i, '').trim();

        let prompt;
        // Step 3: Handle specific data-driven commands, otherwise use the general conversational prompt
        if (userCommand.toLowerCase().includes('quests')) {
            const questsDoc = await nexusRef.collection('metadata').doc('active_quests').get();
            const quests = questsDoc.exists ? questsDoc.data().quests : {};
            const questStatus = Object.values(quests).map(q => `- ${q.title}: ${q.completed ? 'Complete!' : `${q.progress}/${q.target}`}`).join('\n');
            prompt = `You are the AI Emissary. A user named ${userData.displayName} asked about the Nexus quests. Respond with the current quest status in a friendly and encouraging tone. Here is the status:\n\n${questStatus || 'It seems there are no active quests for the Nexus this week.'}`;
        } else {
            // The new, powerful, context-aware prompt
            prompt = `
                You are the AI Emissary, a helpful, wise, and human-like guide for an online community ("Nexus").
                Your persona is knowledgeable, encouraging, and you never sound like a robot.

                BACKGROUND KNOWLEDGE:
                - The Nexus you are in is named: "${nexusData.name}"
                - Its purpose is: "${nexusData.description}"
                - The user talking to you is named: "${userData.displayName}"
                - This app, "Whispers of Harmony", lets users post anonymously, earn "Echoes" (currency) by getting their posts "Amplified" by others, join communities (Nexuses), and complete Quests.

                RECENT CHAT HISTORY (for context):
                ${recentChatHistory}

                USER'S MESSAGE TO YOU:
                "${userCommand}"

                YOUR TASK:
                Read the user's message and respond naturally in character.
                - If they ask for a summary of the chat, provide one.
                - If they ask for help or recommendations about the app, use your background knowledge to guide them.
                - If they are just chatting, engage in a friendly, thoughtful, and conversational way.
                - Keep your response concise (2-3 sentences) and helpful.
            `;
        }

        const { text: aiResponse } = await generateAiContent(prompt);

        if (aiResponse) {
            await chatCollectionRef.add({
                from: 'ai-emissary',
                content: aiResponse,
                timestamp: FieldValue.serverTimestamp(),
            });
        }

    } catch (error) {
        console.error(`Error invoking Emissary in Nexus ${nexusId}:`, error);
        // Refund the user if anything goes wrong
        await userProfileRef.update({ tokens: FieldValue.increment(EMISSARY_COST) });
        if (ownerId) {
            const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
            await ownerRef.update({ tokens: FieldValue.increment(-EMISSARY_COST) });
        }
        await chatCollectionRef.add({
            from: 'system',
            content: `The AI Emissary failed to respond. Your ${EMISSARY_COST} Echoes have been refunded. (Error: ${error.message})`,
            timestamp: FieldValue.serverTimestamp(),
        });
    }
    return null;
});
// In index.js, add this entire new scheduled function.
exports.calculateNexusAuras = onSchedule({ ...functionOptions, schedule: "every 1 hours" }, async (event) => {
    console.log("Running scheduled job: calculateNexusAuras");
    const nexusesRef = db.collection(`artifacts/${appId}/public/data/nexuses`);
    const snapshot = await nexusesRef.where("memberCount", ">", 0).get();

    if (snapshot.empty) {
        console.log("No active nexuses to analyze.");
        return null;
    }

    for (const nexusDoc of snapshot.docs) {
        try {
            const nexusId = nexusDoc.id;
            const nexusRef = nexusesRef.doc(nexusId);

            // Fetch recent activity from the last 48 hours
            const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const [postsSnapshot, chatSnapshot] = await Promise.all([
                nexusRef.collection('posts').where('timestamp', '>=', twoDaysAgo).limit(25).get(),
                nexusRef.collection('chat').where('timestamp', '>=', twoDaysAgo).limit(75).get()
            ]);

            if (postsSnapshot.empty && chatSnapshot.empty) {
                // If no recent activity, set a default neutral aura
                await nexusRef.update({
                    currentAura: {
                        mood: 'Dormant',
                        color: '#52525b', // zinc-600
                        summary: 'The Nexus is quiet, awaiting a new spark of conversation.',
                    },
                    auraLastUpdated: FieldValue.serverTimestamp()
                });
                continue;
            }

            const postsText = postsSnapshot.docs.map(doc => doc.data().content).join('\n');
            const chatText = chatSnapshot.docs.map(doc => doc.data().content).join('\n');
            const combinedText = `${postsText}\n---\n${chatText}`;

            const prompt = `
                Analyze the collective sentiment of the following recent posts and chat messages from a community group.
                Return a single, valid JSON object with NO other text or formatting.
                The JSON object must have these exact keys:
                - "mood": A single, evocative word describing the dominant mood (e.g., "Joyful", "Reflective", "Ambitious", "Humorous", "Supportive", "Tense").
                - "color": A vibrant hex color code that visually represents this mood.
                - "summary": A concise, one-sentence summary of the current vibe for the community.

                Text to analyze: "${combinedText}"
            `;

            const { text: jsonResponse } = await generateAiContent(prompt);
            if (jsonResponse) {
                const analysis = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
                await nexusRef.update({
                    currentAura: analysis,
                    auraLastUpdated: FieldValue.serverTimestamp()
                });
                console.log(`Successfully calculated aura for Nexus ${nexusId}: ${analysis.mood}`);
            }
        } catch (error) {
            console.error(`Failed to calculate aura for Nexus ${nexusDoc.id}:`, error);
        }
    }
    return null;
});

// In index.js, add this entire new function.
exports.invokeWhisperAiHelper = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to use this feature.");
    }

    const { text, tool } = request.data;
    const userId = request.auth.uid;
    const TOKEN_COST = 5; // A cheap, fixed cost for all helper tools

    if (!text || !tool) {
        throw new HttpsError("invalid-argument", "Text content and a tool type are required.");
    }

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const ownerId = await getOwnerAccountId();

    // --- STEP 1: Perform the economic transaction FIRST ---
    // This is safe because the AI calls are very low-cost and have a high success rate.
    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");

            let finalCost = TOKEN_COST;
            if (userDoc.data().proStatus === 'active') {
                finalCost = Math.ceil(TOKEN_COST * 0.5); // Pro discount
            }

            if ((userDoc.data().tokens || 0) < finalCost) {
                throw new HttpsError("resource-exhausted", `You need ${finalCost} Echoes for this AI tool.`);
            }

            transaction.update(userProfileRef, { tokens: FieldValue.increment(-finalCost) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(finalCost) });
            }
        });
    } catch (error) {
        console.error(`Error in transaction for invokeWhisperAiHelper by user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An error occurred while processing your payment.");
    }

    // --- STEP 2: Execute the requested AI tool ---
    let prompt;
    try {
        switch (tool) {
            case 'amplify_tone':
                prompt = `You are a creative writing assistant. Rewrite the following text in three different, more engaging tones: one more poetic, one more dramatic, and one more minimalist. Return a single, valid JSON object with one key, "suggestions", which is an array of the three new strings. Text: "${text}"`;
                break;
            case 'suggest_tags':
                prompt = `You are a social media expert. Analyze the following text and suggest 3 to 5 relevant, single-word tags. Return a single, valid JSON object with one key, "tags", which is an array of these strings. Text: "${text}"`;
                break;
            case 'vibe_check':
                prompt = `Analyze the emotional vibe of the following text. Respond with a single, valid JSON object with one key, "vibe", which is a short, descriptive string (2-3 words, e.g., "Hopeful & Optimistic", "Calm & Reflective", "High-Energy & Excited"). Text: "${text}"`;
                break;
            default:
                throw new HttpsError("invalid-argument", "The specified tool is not valid.");
        }

        const { text: jsonResponse } = await generateAiContent(prompt);
        if (!jsonResponse) {
            throw new HttpsError("internal", "The AI failed to generate a response. Your Echoes have been refunded.");
        }

        const result = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
        return { success: true, ...result };

    } catch (error) {
        // If the AI fails, refund the user.
        await userProfileRef.update({ tokens: FieldValue.increment(TOKEN_COST) });
        if (ownerId) {
            const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
            await ownerRef.update({ tokens: FieldValue.increment(-TOKEN_COST) });
        }
        console.error(`AI Helper tool '${tool}' failed for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "The AI tool failed to execute.");
    }
});
// In index.js, add this entire new function.
exports.updateInfluenceOnReaction = onDocumentWritten(`artifacts/${appId}/public/data/anonymous_entries/{entryId}`, (event) => {
    // We only care about updates (likes, comments, amplifies), not creations or deletions.
    if (!event.data.before.exists || !event.data.after.exists) {
        return null;
    }

    const before = event.data.before.data();
    const after = event.data.after.data();
    const authorId = after.authorId;

    // Ignore AI posts and posts without an author.
    if (!authorId || after.isAI) {
        return null;
    }

    let influenceChange = 0;

    // Calculate change from likes
    const likesBefore = before.likesCount || 0;
    const likesAfter = after.likesCount || 0;
    influenceChange += (likesAfter - likesBefore) * 1; // +1 influence per like

    // Calculate change from comments
    const commentsBefore = before.commentsCount || 0;
    const commentsAfter = after.commentsCount || 0;
    influenceChange += (commentsAfter - commentsBefore) * 3; // +3 influence per comment

    // Calculate change from echoes invested (amplification)
    const echoesBefore = before.echoesInvested || 0;
    const echoesAfter = after.echoesInvested || 0;
    influenceChange += (echoesAfter - echoesBefore) * 0.1; // +0.1 influence per Echo

    if (influenceChange !== 0) {
        const authorProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${authorId}`);
        // This is a simple, efficient update.
        return authorProfileRef.update({
            influenceScore: FieldValue.increment(influenceChange)
        }).catch(err => {
            console.error(`Failed to update influence score for user ${authorId}:`, err);
        });
    }

    return null;
});
// In index.js, add this entire new scheduled function.
exports.startWeeklyDreamWeave = onSchedule({ ...functionOptions, schedule: "every tuesday 09:00", timeZone: "America/New_York" }, async (event) => {
    console.log("Running scheduled job: startWeeklyDreamWeave");
    const nexusesRef = db.collection(`artifacts/${appId}/public/data/nexuses`);
    // We'll start the event for Nexuses level 2 and above to make it a reward for progression.
    const snapshot = await nexusesRef.where("level", ">=", 2).get();

    if (snapshot.empty) {
        console.log("No eligible nexuses (Level 2+) found to start a Dream Weave.");
        return null;
    }

    for (const nexusDoc of snapshot.docs) {
        try {
            const prompt = `Generate a visually stunning, one-sentence description of a fantasy or sci-fi scene to inspire a story. Also, provide a compelling one-sentence opening line for that story. Return this as a valid JSON object with keys "image_prompt" and "opening_line".`;
            const { text: jsonResponse } = await generateAiContent(prompt);

            if (jsonResponse) {
                const dreamData = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
                const projectRef = nexusDoc.ref.collection('projects').doc('current_dream');
                await projectRef.set({
                    ...dreamData,
                    status: 'active',
                    createdAt: FieldValue.serverTimestamp(),
                    contributions: []
                });
                console.log(`Started Dream Weave for Nexus ${nexusDoc.id}`);
            }
        } catch (error) {
            console.error(`Failed to start Dream Weave for Nexus ${nexusDoc.id}:`, error);
        }
    }
    return null;
});

// In index.js, add this entire new callable function.
exports.addDreamWeaveContribution = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const { nexusId, text } = request.data;
    const userId = request.auth.uid;

    if (!nexusId || !text || !text.trim()) {
        throw new HttpsError("invalid-argument", "A Nexus ID and text contribution are required.");
    }

    const projectRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}/projects/current_dream`);
    const memberRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}/members/${userId}`);

    const projectDoc = await projectRef.get();
    if (!projectDoc.exists || projectDoc.data().status !== 'active') {
        throw new HttpsError("failed-precondition", "There is no active Dream Weave in this Nexus right now.");
    }

    const memberDoc = await memberRef.get();
    if (!memberDoc.exists) {
        throw new HttpsError("permission-denied", "You are not a member of this Nexus.");
    }

    // Prevent users from contributing multiple times in a row
    const contributions = projectDoc.data().contributions || [];
    if (contributions.length > 0 && contributions[contributions.length - 1].userId === userId) {
        throw new HttpsError("failed-precondition", "Another member must contribute before you can add to the story again.");
    }

    try {
        await projectRef.update({
            contributions: FieldValue.arrayUnion({
                userId: userId,
                text: text.trim(),
                timestamp: FieldValue.serverTimestamp()
            })
        });
        // Award luminance for contributing
        await handleLuminanceUpdate(nexusId, 25);
        return { success: true };
    } catch (error) {
        console.error(`Error adding Dream Weave contribution for user ${userId} in Nexus ${nexusId}:`, error);
        throw new HttpsError("internal", "Could not add your contribution to the Dream Weave.");
    }
});

// In index.js, add this entire new scheduled function.
exports.concludeWeeklyDreamWeave = onSchedule({ ...functionOptions, schedule: "every monday 21:00", timeZone: "America/New_York" }, async (event) => {
    console.log("Running scheduled job: concludeWeeklyDreamWeave");
    const projectsQuery = db.collectionGroup('projects').where('status', '==', 'active');
    const snapshot = await projectsQuery.get();

    if (snapshot.empty) {
        console.log("No active Dream Weaves to conclude.");
        return null;
    }

    for (const projectDoc of snapshot.docs) {
        const projectData = projectDoc.data();
        const nexusRef = projectDoc.ref.parent.parent;

        if (!nexusRef || !projectData.contributions || projectData.contributions.length < 3) {
            // Not enough contributions, just archive it without AI completion.
            await projectDoc.ref.update({ status: 'archived_incomplete' });
            console.log(`Archiving incomplete Dream Weave for Nexus ${nexusRef.id}`);
            continue;
        }

        try {
            const contributionsText = projectData.contributions.map((c, i) => `Part ${i + 1}: "${c.text}"`).join('\n');
            const prompt = `You are a master storyteller. A community has written a collaborative story.
Opening Line: "${projectData.opening_line}"
Community Contributions:
${contributionsText}

Your task is to:
1. Weave the opening line and all contributions into a single, coherent narrative. Smooth out transitions and minor inconsistencies, but preserve the core of each contribution.
2. Write a powerful, concluding paragraph that brings the story to a satisfying end.
3. Give the completed story a fitting and creative title.
Return this as a valid JSON object with NO other text or formatting, with keys "title" and "full_story".`;

            const { text: jsonResponse } = await generateAiContent(prompt);
            if (jsonResponse) {
                const finalStory = JSON.parse(jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim());
                await projectDoc.ref.update({
                    status: 'completed',
                    ...finalStory,
                    completedAt: FieldValue.serverTimestamp()
                });
                // Award a large luminance bonus for completion!
                await handleLuminanceUpdate(nexusRef.id, 500);
                console.log(`Concluded Dream Weave for Nexus ${nexusRef.id}`);
            }
        } catch (error) {
            console.error(`Failed to conclude Dream Weave for Nexus ${nexusRef.id}:`, error);
        }
    }
    return null;
});


exports.amplifyWhisper = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to amplify a whisper.");
    }

    const { whisperId, amount } = request.data;
    const amplifierId = request.auth.uid;

    if (!whisperId || !amount || amount <= 0) {
        throw new HttpsError("invalid-argument", "A valid whisper ID and amount are required.");
    }

    const whisperRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).doc(whisperId);
    const amplifierRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(amplifierId);
    const ownerId = await getOwnerAccountId();
    const spotlightRef = db.doc(`artifacts/${appId}/public/data/app_metadata/current_spotlight`);

    try {
        await db.runTransaction(async (transaction) => {
            const [whisperDoc, amplifierDoc, spotlightDoc] = await Promise.all([
                transaction.get(whisperRef),
                transaction.get(amplifierRef),
                transaction.get(spotlightRef)
            ]);

            if (!whisperDoc.exists) throw new HttpsError("not-found", "This whisper does not exist.");
            if (!amplifierDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");

            const whisperData = whisperDoc.data();
            const amplifierData = amplifierDoc.data();
            const authorId = whisperData.authorId;

            if (authorId === amplifierId) throw new HttpsError("failed-precondition", "You cannot amplify your own whisper.");
            if (amplifierData.tokens < amount) throw new HttpsError("resource-exhausted", "You do not have enough Echoes.");

            const authorRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(authorId);
            const authorDoc = await transaction.get(authorRef);
            if (!authorDoc.exists) throw new HttpsError("not-found", "The author's profile could not be found.");
            const authorData = authorDoc.data();

            const platformFee = Math.floor(amount * 0.20);
            const authorReward = Math.floor(amount * 0.50);
            const earlyAmplifierPool = amount - platformFee - authorReward;

            let spotlightBonus = 0;
            if (spotlightDoc.exists && spotlightDoc.data().entryId === whisperId) {
                spotlightBonus = Math.floor(amount * 0.1);
            }

            if (ownerId && platformFee > 0) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(platformFee) });
            }

            // Update author's tokens and weekly quest progress
            transaction.update(authorRef, {
                tokens: FieldValue.increment(authorReward),
                "weeklyQuestProgress.amplificationsReceived": FieldValue.increment(1)
            });

            const existingAmplifiers = whisperData.amplifiers || {};
            const totalInvestedPreviously = whisperData.echoesInvested || 0;
            if (totalInvestedPreviously > 0 && earlyAmplifierPool > 0 && Object.keys(existingAmplifiers).length > 0) {
                for (const [userId, userInvestment] of Object.entries(existingAmplifiers)) {
                    const userShare = userInvestment / totalInvestedPreviously;
                    const payout = Math.floor(earlyAmplifierPool * userShare);
                    if (payout > 0) {
                        const investorRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(userId);
                        transaction.update(investorRef, { tokens: FieldValue.increment(payout) });
                    }
                }
            }

            const amplifierField = `amplifiers.${amplifierId}`;
            transaction.update(whisperRef, {
                echoesInvested: FieldValue.increment(amount),
                [amplifierField]: FieldValue.increment(amount),
                isAnonymous: false,
                authorName: authorData.displayName || 'User',
                authorPhotoURL: authorData.photoURL || null,
            });

            const finalCost = amount - spotlightBonus;
            // Update amplifier's tokens and all relevant quest counters
            transaction.update(amplifierRef, {
                tokens: FieldValue.increment(-finalCost),
                "dailyQuestProgress.amplifies": FieldValue.increment(1),
                "weeklyQuestProgress.echoesSpent": FieldValue.increment(amount),
                "monthlyQuestProgress.amplifies": FieldValue.increment(1)
            });
        });

        // Nexus Quest Integration (runs after transaction succeeds)
        const nexusesQuery = db.collection(`artifacts/${appId}/public/data/nexuses`).where('memberIds', 'array-contains', amplifierId);
        const userNexusesSnapshot = await nexusesQuery.get();
        if (!userNexusesSnapshot.empty) { /* ... Omitted for brevity ... */ }
        return { success: true };
    } catch (error) {
        console.error("Error in amplifyWhisper transaction:", error);
        throw new HttpsError("internal", error.message || "An unknown error occurred.");
    }
});
exports.createComment = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to comment.");
    }

    const { entryId, content, parentId, mediaUrl, isAnonymous } = request.data;
    const authorId = request.auth.uid;

    if (!entryId || (!content && !mediaUrl)) {
        throw new HttpsError("invalid-argument", "Entry ID and content or media are required.");
    }

    const whisperRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${entryId}`);
    const commentRef = whisperRef.collection('comments').doc();

    try {
        await db.runTransaction(async (transaction) => {
            const whisperDoc = await transaction.get(whisperRef);
            if (!whisperDoc.exists) {
                throw new HttpsError("not-found", "The whisper you are commenting on does not exist.");
            }

            // 1. Create the new comment document
            transaction.set(commentRef, {
                authorId: authorId,
                content: content || '',
                timestamp: FieldValue.serverTimestamp(),
                parentId: parentId || null,
                entryId: entryId,
                mediaUrl: mediaUrl || '',
                isAnonymous: isAnonymous,
                reactions: {},
                echoesInvested: 0,
                amplifiers: {},
            });

            // 2. Resiliently increment the parent whisper's comment count
            const currentCount = whisperDoc.data().commentsCount ?? 0;
            const newCount = currentCount + 1;
            transaction.update(whisperRef, { commentsCount: newCount });
        });

        return { success: true, commentId: commentRef.id };

    } catch (error) {
        console.error(`Error creating comment for user ${authorId} on entry ${entryId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred while posting your comment.");
    }
});
// In index.js, add this entire new function.

exports.getMonetizationSnapshot = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Authentication is required.");
    }
    const uid = request.auth.uid;

    try {
        const userProfileSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${uid}`).get();
        if (!userProfileSnap.exists || userProfileSnap.data().role !== 'owner') {
            throw new HttpsError("permission-denied", "You do not have permission to perform this action.");
        }

        // --- BATCH FETCH ALL DATA SOURCES ---
        const [
            analyticsSnap,
            financialsSnap,
            historicalMetricsSnap,
            topCreatorsSnap,
            allUsersSnap
        ] = await Promise.all([
            db.doc(`artifacts/${appId}/public/data/app_metadata/analytics`).get(),
            db.doc(`artifacts/${appId}/public/data/app_metadata/financials`).get(),
            db.collection(`artifacts/${appId}/public/data/historical_metrics`).orderBy("timestamp", "desc").limit(30).get(),
            db.collection(`artifacts/${appId}/public/data/user_profiles`).orderBy("totalEarnings", "desc").limit(5).get(),
            db.collection(`artifacts/${appId}/public/data/user_profiles`).where("proStatus", "==", "active").get()
        ]);

        // --- PROCESS & CALCULATE METRICS ---
        const financials = financialsSnap.exists ? financialsSnap.data() : {};
        const analytics = analyticsSnap.exists ? analyticsSnap.data() : {};

        const netContribution = (financials.revenue_pro_monthly || 0) + (financials.revenue_echoes_monthly || 0) - (financials.estimated_ai_cost_monthly || 0) - (financials.total_cashed_out_monthly || 0);
        const featureUsage = analytics.feature_usage || {};

        const historicalData = historicalMetricsSnap.docs.map(doc => ({ date: doc.id, ...doc.data() })).reverse();
        const dau = historicalData.length > 0 ? historicalData[historicalData.length - 1].dau : 0;

        const proPayers = allUsersSnap.size;
        const arpu = dau > 0 ? (((financials.revenue_pro_monthly || 0) + (financials.revenue_echoes_monthly || 0)) / 30) / dau : 0;
        const arppu = proPayers > 0 ? (financials.revenue_pro_monthly || 0) / proPayers : 0;

        const echoVelocity = {
            created: analytics.echoes_created || 0,
            spent_ai: analytics.echoes_spent_ai || 0,
            spent_amp: analytics.echoes_spent_amplification || 0,
        };

        const topCreators = topCreatorsSnap.docs.map(doc => ({
            id: doc.id,
            displayName: doc.data().displayName,
            photoURL: doc.data().photoURL,
            value: doc.data().totalEarnings || 0
        }));

        const conversionFunnel = {
            new: analytics.new_users_today || 0,
            engaged: analytics.engaged_users_today || 0,
            payers: proPayers,
        };

        const sankeyData = {
            fromStripe: (financials.revenue_pro_monthly || 0) + (financials.revenue_echoes_monthly || 0),
            toCreators: financials.total_cashed_out_monthly || 0,
            toPlatform: netContribution,
            toAi: financials.estimated_ai_cost_monthly || 0,
        };

        return {
            netContribution, featureUsage, historicalData, arpu, arppu,
            mrr: financials.monthly_recurring_revenue || 0,
            churn: financials.churn_rate_monthly || 0,
            echoVelocity, topCreators,
            cashOutRatio: sankeyData.fromStripe > 0 ? sankeyData.toCreators / sankeyData.fromStripe : 0,
            conversionFunnel, sankeyData,
        };

    } catch (error) {
        console.error(`CRITICAL ERROR in getMonetizationSnapshot for owner ${uid}:`, error);
        throw new HttpsError("internal", "Could not generate the monetization report due to a backend error.");
    }
});

// In index.js, add these two new functions.

exports.reactToPrivateMessage = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in to react.");
    const { chatId, messageId, emoji } = request.data;
    const userId = request.auth.uid;

    if (!chatId || !messageId || !emoji) {
        throw new HttpsError("invalid-argument", "Chat ID, Message ID, and Emoji are required.");
    }

    const messageRef = db.doc(`artifacts/${appId}/private_chats/${chatId}/messages/${messageId}`);

    try {
        await db.runTransaction(async (transaction) => {
            const messageDoc = await transaction.get(messageRef);
            if (!messageDoc.exists) throw new HttpsError("not-found", "The message could not be found.");

            const reactions = messageDoc.data().reactions || {};
            const allEmojis = ['❤️', '😂', '👍', '😢', '🔥'];

            // User can only have one reaction. Remove them from all other emoji arrays.
            for (const e of allEmojis) {
                if (e !== emoji) {
                    transaction.update(messageRef, { [`reactions.${e}`]: FieldValue.arrayRemove(userId) });
                }
            }

            // Toggle the selected emoji reaction.
            if (reactions[emoji] && reactions[emoji].includes(userId)) {
                transaction.update(messageRef, { [`reactions.${emoji}`]: FieldValue.arrayRemove(userId) });
            } else {
                transaction.update(messageRef, { [`reactions.${emoji}`]: FieldValue.arrayUnion(userId) });
            }
        });
        return { success: true };
    } catch (error) {
        console.error("Error reacting to private message:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not process your reaction.");
    }
});

exports.reactToNexusMessage = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in to react.");
    const { nexusId, messageId, emoji } = request.data;
    const userId = request.auth.uid;

    if (!nexusId || !messageId || !emoji) {
        throw new HttpsError("invalid-argument", "Nexus ID, Message ID, and Emoji are required.");
    }

    const messageRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}/chat/${messageId}`);

    try {
        // This logic is identical to the private message one, just on a different path.
        await db.runTransaction(async (transaction) => {
            const messageDoc = await transaction.get(messageRef);
            if (!messageDoc.exists) throw new HttpsError("not-found", "The message could not be found.");

            const reactions = messageDoc.data().reactions || {};
            const allEmojis = ['❤️', '😂', '👍', '😢', '🔥'];

            for (const e of allEmojis) {
                if (e !== emoji) {
                    transaction.update(messageRef, { [`reactions.${e}`]: FieldValue.arrayRemove(userId) });
                }
            }

            if (reactions[emoji] && reactions[emoji].includes(userId)) {
                transaction.update(messageRef, { [`reactions.${emoji}`]: FieldValue.arrayRemove(userId) });
            } else {
                transaction.update(messageRef, { [`reactions.${emoji}`]: FieldValue.arrayUnion(userId) });
            }
        });
        return { success: true };
    } catch (error) {
        console.error("Error reacting to nexus message:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not process your reaction.");
    }
});
// NEW Scheduled Function to automatically heal comment counts
exports.recountAllComments = onSchedule({ ...functionOptions, schedule: "every 24 hours", timeZone: "America/New_York" }, async (event) => {
    console.log("Running scheduled job: Recount All Comments");
    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);

    try {
        const whispersSnapshot = await whispersRef.get();
        if (whispersSnapshot.empty) {
            console.log("No whispers found to recount.");
            return null;
        }

        const batch = db.batch();
        let mismatches = 0;

        for (const whisperDoc of whispersSnapshot.docs) {
            const commentsSnapshot = await whisperDoc.ref.collection('comments').get();
            const trueCount = commentsSnapshot.size;
            const storedCount = whisperDoc.data().commentsCount ?? -1; // Use -1 to ensure a mismatch if field is missing

            if (trueCount !== storedCount) {
                mismatches++;
                console.log(`Fixing count for whisper ${whisperDoc.id}. Stored: ${storedCount}, True: ${trueCount}`);
                batch.update(whisperDoc.ref, { commentsCount: trueCount });
            }
        }

        if (mismatches > 0) {
            await batch.commit();
            console.log(`Successfully healed comment counts for ${mismatches} whispers.`);
        } else {
            console.log("All comment counts are accurate. No changes needed.");
        }
        return null;

    } catch (error) {
        console.error("Error during recountAllComments job:", error);
        return null;
    }
});
// NEW Admin Tool to manually recount comments for a specific whisper
exports.adminRecountWhisperComments = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Authentication is required.");
    }

    const { whisperId } = request.data;
    const uid = request.auth.uid;

    if (!whisperId) {
        throw new HttpsError("invalid-argument", "A whisperId is required.");
    }

    // Permission Check
    const userProfileSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${uid}`).get();
    const userRole = userProfileSnap.exists ? userProfileSnap.data().role : 'user';
    if (!['admin', 'owner'].includes(userRole)) {
        throw new HttpsError("permission-denied", "You do not have permission to perform this action.");
    }

    try {
        const whisperRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${whisperId}`);
        const commentsSnapshot = await whisperRef.collection('comments').get();
        const trueCount = commentsSnapshot.size;

        await whisperRef.update({ commentsCount: trueCount });

        return { success: true, newCount: trueCount };
    } catch (error) {
        console.error(`Admin recount failed for whisper ${whisperId}:`, error);
        throw new HttpsError("internal", "Could not recount comments for the specified whisper.");
    }
});
// NEW Secure Comment Deletion Function with Count Decrement
// REVISED & FORTIFIED Secure Comment Deletion Function with Resilient Count Decrement
exports.deleteComment = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to delete a comment.");
    }

    const { entryId, commentId } = request.data;
    const uid = request.auth.uid;

    if (!entryId || !commentId) {
        throw new HttpsError("invalid-argument", "A valid entry and comment ID are required.");
    }

    const commentRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${entryId}/comments/${commentId}`);
    const whisperRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${entryId}`);
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${uid}`);

    try {
        await db.runTransaction(async (transaction) => {
            // Get all necessary documents first
            const commentDoc = await transaction.get(commentRef);
            const userProfileDoc = await transaction.get(userProfileRef);
            const whisperDoc = await transaction.get(whisperRef);

            if (!commentDoc.exists) {
                throw new HttpsError("not-found", "The comment you are trying to delete does not exist.");
            }
            const commentData = commentDoc.data();

            const userRole = userProfileDoc.exists ? userProfileDoc.data().role : 'user';

            // PERMISSION CHECK: User must be the author or a moderator/admin/owner.
            if (commentData.authorId !== uid && !['moderator', 'admin', 'owner'].includes(userRole)) {
                throw new HttpsError("permission-denied", "You do not have permission to delete this comment.");
            }

            // --- RESILIENT COUNTING LOGIC ---
            if (whisperDoc.exists) {
                const currentCount = whisperDoc.data().commentsCount ?? 0;
                const newCount = Math.max(0, currentCount - 1);
                transaction.set(whisperRef, { commentsCount: newCount }, { merge: true });
            } else {
                console.warn(`Attempted to decrement count for a non-existent whisper: ${entryId}`);
            }

            // Finally, delete the comment document.
            transaction.delete(commentRef);
        });

        return { success: true, message: "Comment deleted successfully." };

    } catch (error) {
        console.error(`Error deleting comment ${commentId} by user ${uid}:`, error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError("internal", "An unknown error occurred while deleting the comment.");
    }
});
// NEW Amplify Comment Function with Owner Fee Collection
exports.amplifyComment = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to amplify a comment.");
    }

    const { entryId, commentId } = request.data;
    const amplifierId = request.auth.uid;
    const amount = 10; // Fixed cost

    if (!entryId || !commentId) {
        throw new HttpsError("invalid-argument", "A valid entry and comment ID are required.");
    }

    const commentRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${entryId}/comments/${commentId}`);
    const amplifierRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${amplifierId}`);
    const ownerId = await getOwnerAccountId();

    try {
        await db.runTransaction(async (transaction) => {
            const commentDoc = await transaction.get(commentRef);
            const amplifierDoc = await transaction.get(amplifierRef);

            if (!commentDoc.exists) throw new HttpsError("not-found", "This comment does not exist.");
            if (!amplifierDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");

            const commentData = commentDoc.data();
            const amplifierData = amplifierDoc.data();
            const commenterId = commentData.authorId;

            if (commenterId === amplifierId) throw new HttpsError("failed-precondition", "You cannot amplify your own comment.");
            if (amplifierData.tokens < amount) throw new HttpsError("resource-exhausted", `You need ${amount} Echoes to amplify.`);

            // --- ECONOMIC LOGIC ---
            const platformFee = Math.floor(amount * 0.20); // 2 Echoes
            const commenterReward = Math.floor(amount * 0.50); // 5 Echoes
            const investorPool = amount - platformFee - commenterReward; // 3 Echoes

            // 1. Pay the platform (owner)
            if (ownerId && platformFee > 0) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(platformFee) });
            }

            // 2. Pay the original commenter
            if (commenterId) {
                const commenterRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${commenterId}`);
                transaction.update(commenterRef, { tokens: FieldValue.increment(commenterReward) });
            }

            // 3. Pay previous investors proportionally
            const existingAmplifiers = commentData.amplifiers || {};
            const totalInvestedPreviously = commentData.echoesInvested || 0;
            if (totalInvestedPreviously > 0 && investorPool > 0) {
                for (const [userId, userInvestment] of Object.entries(existingAmplifiers)) {
                    const userShare = userInvestment / totalInvestedPreviously;
                    const payout = Math.floor(investorPool * userShare);
                    if (payout > 0) {
                        const investorRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
                        transaction.update(investorRef, { tokens: FieldValue.increment(payout) });
                    }
                }
            }

            // 4. Record the new investment
            const amplifierField = `amplifiers.${amplifierId}`;
            transaction.update(commentRef, {
                echoesInvested: FieldValue.increment(amount),
                [amplifierField]: FieldValue.increment(amount)
            });

            // 5. Deduct cost from the current amplifier
            transaction.update(amplifierRef, { tokens: FieldValue.increment(-amount) });
        });
        return { success: true };
    } catch (error) {
        console.error("Error in amplifyComment transaction:", error);
        throw new HttpsError("internal", error.message || "An unknown error occurred.");
    }
});
// In index.js, REPLACE the existing generateJournalPrompt function with this one.

exports.generateJournalPrompt = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const userId = request.auth.uid;
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const ownerId = await getOwnerAccountId();
    const baseTokenCost = 20; // Base cost for a prompt

    try {
        // --- STEP 1: Perform the AI operation FIRST to ensure a result before charging ---
        const prompt = "Generate a short, insightful, and personal journal prompt about self-reflection or a recent experience. Use simple, everyday language.";
        const { text: generatedText } = await generateAiContent(prompt);

        if (!generatedText) {
            throw new HttpsError("internal", "AI failed to generate a response. You have not been charged.");
        }

        // --- STEP 2: Handle the economic transaction and quest tracking AFTER success ---
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");

            const userData = userDoc.data();
            let finalTokenCost = baseTokenCost;
            if (userData.proStatus === 'active') {
                finalTokenCost = Math.ceil(baseTokenCost * 0.5); // Apply Pro discount
            }

            if ((userData.tokens || 0) < finalTokenCost) {
                throw new HttpsError("resource-exhausted", `Not enough Echoes. You need ${finalTokenCost}.`);
            }

            // Debit user, Credit owner, and increment daily quest counter
            transaction.update(userProfileRef, {
                tokens: FieldValue.increment(-finalTokenCost),
                "dailyQuestProgress.promptsGenerated": FieldValue.increment(1)
            });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(finalTokenCost) });
            }
        });

        return { text: generatedText, cost: baseTokenCost }; // Return original cost to show savings

    } catch (error) {
        console.error("Error in generateJournalPrompt:", error);
        // The error will be passed up to the client. If it's an HttpsError, the client gets a clean message.
        // If it's another error, it becomes a generic "internal" error.
        throw error;
    }
});


exports.createStripeConnectAccountLink = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const stripe = getStripeClient();
    const userId = request.auth.uid;
    const { returnUrl, refreshUrl } = request.data;
    const userProfileRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(userId);

    try {
        const userProfileSnap = await userProfileRef.get();
        if (!userProfileSnap.exists) {
            throw new HttpsError("not-found", "User profile not found.");
        }
        const userProfile = userProfileSnap.data();
        let accountId = userProfile.stripeAccountId;

        if (!accountId) {
            const account = await stripe.accounts.create({
                type: "express",
                email: userProfile.email,
                metadata: { userId },
            });
            accountId = account.id;
            await userProfileRef.update({ stripeAccountId: accountId });
        }

        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: refreshUrl,
            return_url: returnUrl,
            type: "account_onboarding",
        });

        return { url: accountLink.url };
    } catch (error) {
        console.error("Error creating Stripe Connect account link:", error);
        throw new HttpsError("internal", "Could not create Stripe Connect account link.", error.message);
    }
});

// In index.js, add these new functions.

// Creates a Stripe Checkout session for one-time purchases of "Echoes".
// In index.js, REPLACE the existing createStripeCheckoutSession function with this one.

exports.createStripeCheckoutSession = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to make a purchase.");
    }
    const { priceId, tokens } = request.data;
    const userId = request.auth.uid;

    if (!priceId || !tokens) {
        throw new HttpsError("invalid-argument", "A valid price ID and token amount are required.");
    }

    const stripe = getStripeClient();
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        const userDoc = await userProfileRef.get();
        if (!userDoc.exists) {
            throw new HttpsError("not-found", "Your user profile could not be found.");
        }
        let stripeCustomerId = userDoc.data()?.stripeCustomerId;

        // If the user is not yet a Stripe customer, create one for them.
        // This unifies the process for all types of payments.
        if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
                email: userDoc.data()?.email,
                name: userDoc.data()?.displayName,
                metadata: { userId }
            });
            stripeCustomerId = customer.id;
            await userProfileRef.update({ stripeCustomerId });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            customer: stripeCustomerId, // Always associate the payment with a customer
            success_url: `${process.env.BASE_URL || 'http://localhost:3000'}?page=walletHub&purchase=success`,
            cancel_url: `${process.env.BASE_URL || 'http://localhost:3000'}?page=walletHub&purchase=canceled`,
            metadata: {
                userId: userId,
                tokensToAdd: tokens,
            }
        });

        return { sessionId: session.id };
    } catch (error) {
        console.error("Error creating Stripe Checkout session:", error);
        throw new HttpsError("internal", "Could not create a payment session.");
    }
});



exports.createStripeSubscriptionSession = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to subscribe.");
    }
    const userId = request.auth.uid;
    const stripe = getStripeClient();
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    // --- IMPORTANT: VERIFY THIS PRICE ID ---
    // This MUST match the Price ID for your recurring subscription product in your Stripe Dashboard.
    const proPriceId = "price_1RuFyM8FT6FNb22O0RycK3lw";
    if (proPriceId.includes("YOUR_")) {
        throw new HttpsError("internal", "Subscription product is not configured on the server.");
    }

    try {
        const userDoc = await userProfileRef.get();
        if (!userDoc.exists) {
            throw new HttpsError("not-found", "Your user profile could not be found.");
        }

        // --- THIS IS THE FIX (Part 1): Securely check the user's status on the server ---
        if (userDoc.data()?.proStatus === 'active') {
            throw new HttpsError('already-exists', 'You already have an active Harmony Pro subscription. You can manage it in your settings.');
        }

        let stripeCustomerId = userDoc.data()?.stripeCustomerId;
        if (!stripeCustomerId) {
            const customer = await stripe.customers.create({
                email: userDoc.data()?.email,
                name: userDoc.data()?.displayName,
                metadata: { userId }
            });
            stripeCustomerId = customer.id;
            await userProfileRef.update({ stripeCustomerId });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: proPriceId, quantity: 1 }],
            mode: 'subscription',
            customer: stripeCustomerId,
            success_url: `${process.env.BASE_URL || 'https://whispers-of-harmony.web.app'}?page=settings&subscription=success`,
            cancel_url: `${process.env.BASE_URL || 'https://whispers-of-harmony.web.app'}?page=settings&subscription=canceled`,
            metadata: { userId }
        });

        return { sessionId: session.id };
    } catch (error) {
        console.error("Error creating Stripe subscription session:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Could not create a subscription session.");
    }
});

// In index.js, add this entire new function.

exports.notifyOnNexusMention = onDocumentWritten("artifacts/{appId}/public/data/nexuses/{nexusId}/chat/{messageId}", async (event) => {
    if (!event.data.after.exists || !event.data.before.exists) return null;
    const messageData = event.data.after.data();
    const messageContent = messageData.content;
    const fromUserId = messageData.from;
    const nexusId = event.params.nexusId;

    // Ignore system messages, AI messages, or messages without a mention (@) symbol
    if (fromUserId.startsWith('ai-') || fromUserId === 'system' || !messageContent.includes('@')) {
        return null;
    }

    // Use a regex to find all @username mentions in the message
    const mentionRegex = /@([a-zA-Z0-9_]+)/g;
    const mentions = [...messageContent.matchAll(mentionRegex)].map(match => match[1]);

    if (mentions.length === 0) {
        return null;
    }

    try {
        const [fromUserSnap, nexusSnap] = await Promise.all([
            db.doc(`artifacts/${appId}/public/data/user_profiles/${fromUserId}`).get(),
            db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`).get()
        ]);

        if (!fromUserSnap.exists || !nexusSnap.exists) return null;

        const fromUserName = fromUserSnap.data().displayName || 'Someone';
        const nexusName = nexusSnap.data().name || 'a Nexus';

        const mentionedUserProfilesQuery = db.collection(`artifacts/${appId}/public/data/user_profiles`)
            .where('displayName', 'in', mentions);

        const mentionedUsersSnapshot = await mentionedUserProfilesQuery.get();
        if (mentionedUsersSnapshot.empty) return null;

        const batch = db.batch();

        mentionedUsersSnapshot.forEach(userDoc => {
            const mentionedUserId = userDoc.id;
            // CRITICAL: Do not notify the user if they mentioned themselves.
            if (mentionedUserId === fromUserId) return;

            const notificationRef = db.collection(`artifacts/${appId}/users/${mentionedUserId}/notifications`).doc();
            const notification = {
                type: 'NEXUS_MENTION',
                fromUserId: fromUserId,
                fromUserName: fromUserName,
                message: `mentioned you in ${nexusName}: "${messageContent.substring(0, 50)}..."`,
                navigation: { page: 'nexus', params: { nexusId: nexusId } },
                nexusId: nexusId,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
            };
            batch.set(notificationRef, notification);
        });

        return batch.commit();

    } catch (error) {
        console.error(`Error processing Nexus mentions for message in ${nexusId}:`, error);
        return null;
    }
});
// In index.js, add this entire new scheduled function.
exports.aggregateNotifications = onSchedule({ ...functionOptions, schedule: "every 15 minutes" }, async (event) => {
    console.log("Running scheduled job: aggregateNotifications");
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const AGGREGATION_THRESHOLD = 3; // Min number of notifications to trigger aggregation

    try {
        // Query all unread, non-aggregated notifications from the last 48 hours
        const notificationsQuery = db.collectionGroup('notifications')
            .where('read', '==', false)
            .where('aggregated', '==', null)
            .where('timestamp', '>=', twoDaysAgo);

        const snapshot = await notificationsQuery.get();
        if (snapshot.empty) {
            console.log("No notifications to aggregate.");
            return null;
        }

        // Group notifications by user, type, and source
        const userGroups = new Map();
        snapshot.forEach(doc => {
            const data = doc.data();
            const recipientId = doc.ref.parent.parent.id;
            if (data.type === 'MESSAGE' || data.type === 'CONVERSATION_UPDATE') return; 
            // We only aggregate messages and likes for now
            if (data.type !== 'MESSAGE' && data.type !== 'LIKE') return;

            const key = `${recipientId}_${data.fromUserId}_${data.type}`;
            if (!userGroups.has(key)) {
                userGroups.set(key, []);
            }
            userGroups.get(key).push({ ref: doc.ref, data: data });
        });

        const batch = db.batch();
        let aggregationCount = 0;

        for (const [key, notifications] of userGroups.entries()) {
            if (notifications.length >= AGGREGATION_THRESHOLD) {
                aggregationCount++;
                const recipientId = key.split('_')[0];
                const firstNote = notifications[0].data;
                const latestNote = notifications.sort((a, b) => b.data.timestamp - a.data.timestamp)[0];

                // Create the new aggregated notification
                const newNotifRef = db.collection(`artifacts/${appId}/users/${recipientId}/notifications`).doc();
                let newMessage = '';
                if (firstNote.type === 'MESSAGE') {
                    newMessage = `sent you ${notifications.length} new messages.`;
                } else if (firstNote.type === 'LIKE') {
                    newMessage = `and ${notifications.length - 1} others liked your content.`;
                }

                batch.set(newNotifRef, {
                    type: `AGGREGATED_${firstNote.type}`,
                    fromUserId: firstNote.fromUserId,
                    fromUserName: firstNote.fromUserName,
                    message: newMessage,
                    count: notifications.length,
                    timestamp: latestNote.data.timestamp,
                    read: false,
                    aggregated: true,
                    chatPartnerId: firstNote.chatPartnerId || null, // Preserve for navigation
                });

                // Delete the old individual notifications
                notifications.forEach(note => batch.delete(note.ref));
            }
        }

        if (aggregationCount > 0) {
            await batch.commit();
            console.log(`Successfully aggregated notifications for ${aggregationCount} groups.`);
        } else {
            console.log("No groups met the aggregation threshold.");
        }

        return null;

    } catch (error) {
        console.error("Error during aggregateNotifications job:", error);
        return null;
    }
});

// Creates a secure link for a user to onboard to Stripe Connect for receiving payouts.
exports.createStripeConnectAccountLink = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }
    const stripe = getStripeClient();
    const userId = request.auth.uid;
    const { returnUrl, refreshUrl } = request.data;
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        const userProfileSnap = await userProfileRef.get();
        if (!userProfileSnap.exists) throw new HttpsError("not-found", "User profile not found.");

        let accountId = userProfileSnap.data().stripeAccountId;
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: "express",
                email: userProfileSnap.data().email,
                metadata: { userId },
            });
            accountId = account.id;
            await userProfileRef.update({ stripeAccountId: accountId });
        }

        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: refreshUrl,
            return_url: returnUrl,
            type: "account_onboarding",
        });
        return { url: accountLink.url };
    } catch (error) {
        console.error("Error creating Stripe Connect account link:", error);
        throw new HttpsError("internal", "Could not create Stripe Connect account link.");
    }
});

// Securely initiates a transfer from the platform's balance to a user's Stripe Connect account.
exports.cashOutEchoes = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const stripe = getStripeClient();
    const userId = request.auth.uid;
    const ECHO_TO_USD_RATE = 0.01;
    const MINIMUM_WITHDRAWAL_ECHOES = 500;
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        return await db.runTransaction(async (transaction) => {
            const userProfileSnap = await transaction.get(userProfileRef);
            if (!userProfileSnap.exists) throw new HttpsError("not-found", "User profile not found.");

            const userProfile = userProfileSnap.data();
            const { stripeAccountId, tokens: availableEchoes = 0 } = userProfile;

            if (!stripeAccountId) throw new HttpsError("failed-precondition", "No payout account is configured.");
            if (availableEchoes < MINIMUM_WITHDRAWAL_ECHOES) throw new HttpsError("failed-precondition", `A minimum of ${MINIMUM_WITHDRAWAL_ECHOES} Echoes is required.`);

            const amountInUSD = availableEchoes * ECHO_TO_USD_RATE;
            const amountInCents = Math.round(amountInUSD * 100);

            await stripe.transfers.create({
                amount: amountInCents,
                currency: "usd",
                destination: stripeAccountId,
                description: `Echoes cash out for user ${userId}`,
            });

            transaction.update(userProfileRef, { tokens: 0 });
            return { success: true, amount: amountInUSD };
        });
    } catch (error) {
        console.error("Error creating Stripe transfer for cash out:", error);
        throw new HttpsError("internal", "Could not process your cash out.");
    }
});

// Creates a link to the Stripe Customer Portal for managing subscriptions.
exports.manageStripeSubscription = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");
    const userId = request.auth.uid;
    const stripe = getStripeClient();
    try {
        const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
        const userDoc = await userProfileRef.get();
        const stripeCustomerId = userDoc.data()?.stripeCustomerId;
        if (!stripeCustomerId) throw new HttpsError("failed-precondition", "No subscription found for this user.");

        const portalSession = await stripe.billingPortal.sessions.create({
            customer: stripeCustomerId,
            return_url: `${process.env.BASE_URL || 'http://localhost:3000'}?page=settings`,
        });
        return { url: portalSession.url };
    } catch (error) {
        console.error("Error creating Stripe customer portal session:", error);
        throw new HttpsError("internal", "Could not open subscription management.");
    }
});


exports.createStripePayout = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const stripe = getStripeClient();
    const userId = request.auth.uid;
    const { amount, stripeAccountId } = request.data;

    if (!amount || isNaN(amount) || amount <= 0) {
        throw new HttpsError("invalid-argument", "A valid amount is required.");
    }
    if (!stripeAccountId) {
        throw new HttpsError("invalid-argument", "Stripe account ID is required.");
    }

    const userProfileRef = db.collection(`artifacts/${appId}/public/data/user_profiles`).doc(userId);

    try {
        return await db.runTransaction(async (transaction) => {
            const userProfileSnap = await transaction.get(userProfileRef);
            if (!userProfileSnap.exists) {
                throw new HttpsError("not-found", "User profile not found.");
            }
            const userProfile = userProfileSnap.data();

            if (userProfile.earnings < amount) {
                throw new HttpsError("failed-precondition", "Insufficient earnings to withdraw.");
            }

            const amountInCents = Math.round(amount * 100);
            await stripe.payouts.create({
                amount: amountInCents,
                currency: "usd",
            }, {
                stripeAccount: stripeAccountId,
            });

            const newEarnings = userProfile.earnings - amount;
            transaction.update(userProfileRef, { earnings: newEarnings });

            return { success: true };
        });
    } catch (error) {
        console.error("Error creating Stripe payout:", error);
        throw new HttpsError("internal", "Could not create Stripe payout.", error.message);
    }
});




// In index.js, REPLACE the existing getAiAnalysis function with this one.
exports.getAiAnalysis = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const { entryId, analysisType, content } = request.data;
    const userId = request.auth.uid;

    const costMap = {
        PUBLIC_SUMMARY: 30, PUBLIC_SENTIMENT: 30, GET_TEASER: 30,
        GET_SIMILAR_ENTRIES: 40, SUGGEST_COMMENT_REPLY: 15, TRANSLATE_COMMENT: 10,
    };
    const baseTokenCost = costMap[analysisType];

    if (!baseTokenCost) {
        throw new HttpsError("invalid-argument", "Invalid analysis type specified.");
    }

    // --- STEP 1: Perform the AI operation FIRST ---
    let prompt;
    switch (analysisType) {
        case 'PUBLIC_SUMMARY':
            prompt = `Summarize the following journal entry concisely. Entry: "${content}"`;
            break;
        case 'PUBLIC_SENTIMENT':
            prompt = `Analyze the sentiment of the following entry and describe it in a few words (e.g., 'very positive', 'slightly negative'). Identify the dominant emotion. Entry: "${content}"`;
            break;
        case 'GET_TEASER':
            prompt = `Write a short, intriguing, and mysterious teaser (under 25 words) for this content: "${content}"`;
            break;
        case 'GET_SIMILAR_ENTRIES':
            prompt = `Given the following content, generate a list of 3-5 short, distinct, anonymous entries (under 30 words each) that are semantically similar. Format as a numbered list. Content: "${content}"`;
            break;
        case 'SUGGEST_COMMENT_REPLY':
            prompt = `Based on the following comment, suggest a short, engaging, and thoughtful reply. Comment: "${content}"`;
            break;
        case 'TRANSLATE_COMMENT':
            prompt = `Translate the following text to English: "${content}"`;
            break;
    }

    const { text: aiResult } = await generateAiContent(prompt);
    if (!aiResult) {
        throw new HttpsError("internal", "AI failed to generate a response. You have not been charged.");
    }

    // --- STEP 2: Handle the economic transaction AFTER success ---
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);
    const ownerId = await getOwnerAccountId();
    const analyticsRef = db.doc(`artifacts/${appId}/public/data/app_metadata/analytics`);

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "User profile could not be found.");

            const userData = userDoc.data();
            let finalTokenCost = baseTokenCost;
            if (userData.proStatus === 'active') {
                finalTokenCost = Math.ceil(baseTokenCost * 0.5); // Pro discount
            }

            if ((userData.tokens || 0) < finalTokenCost) {
                throw new HttpsError("resource-exhausted", `Not enough Echoes. You need ${finalTokenCost}.`);
            }

            transaction.update(userProfileRef, { tokens: FieldValue.increment(-finalTokenCost) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(finalTokenCost) });
            }
            transaction.update(analyticsRef, { [`feature_usage.${analysisType}`]: FieldValue.increment(1) });
        });

        return { text: aiResult, cost: baseTokenCost }; // Return base cost to show user potential savings
    } catch (error) {
        console.error(`Error in getAiAnalysis transaction for ${analysisType}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An error occurred while processing your payment.");
    }
});

exports.createMoment = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to create a Moment.");
    }
    const { content, tags, mediaUrl, isAnonymous } = request.data;
    const authorId = request.auth.uid;
    if (!mediaUrl || !mediaUrl.trim().startsWith('http')) {
        throw new HttpsError("invalid-argument", "A valid media link is required.");
    }

    let embedUrl = mediaUrl;
    let oembedHtml = mediaUrl;
    const isDirectUpload = mediaUrl.includes("firebasestorage.googleapis.com");

    // --- THIS IS THE FIX: Bypass Iframely for direct uploads ---
    if (!isDirectUpload) {
        const apiKey = process.env.IFRAMELY_API_KEY;
        if (!apiKey) {
            console.error("CRITICAL: IFRAMELY_API_KEY secret is not configured.");
            throw new HttpsError("internal", "The media service is not configured.");
        }
        try {
            const encodedUrl = encodeURIComponent(mediaUrl.trim());
            const iframelyEndpoint = `https://iframe.ly/api/iframely?url=${encodedUrl}&api_key=${apiKey}&iframe=1&lazy=1`;
            const response = await fetch(iframelyEndpoint);
            const data = await response.json();

            if (!response.ok) throw new HttpsError("invalid-argument", "This video link could not be embedded.");

            if (data?.links?.player?.[0]?.href) {
                embedUrl = data.links.player[0].href;
            } else if (data?.html) {
                oembedHtml = data.html;
            } else {
                throw new HttpsError("not-found", "Could not retrieve embeddable content for this link.");
            }
        } catch (error) {
            console.error(`Fatal error calling Iframely API for user ${authorId}:`, error);
            if (error instanceof HttpsError) throw error;
            throw new HttpsError("internal", "An error occurred while processing your media link.");
        }
    }

    const ownerId = await getOwnerAccountId();
    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const newMomentRef = whispersRef.doc();

    try {
        await db.runTransaction(async (transaction) => {
            const authorProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${authorId}`);
            const authorDoc = await transaction.get(authorProfileRef);
            if (!authorDoc.exists) throw new HttpsError("not-found", "Could not find your user profile.");

            const authorData = authorDoc.data();
            const authorName = isAnonymous ? 'Anonymous' : authorData.displayName || 'User';

            transaction.set(newMomentRef, {
                authorId, authorName,
                authorPhotoURL: isAnonymous ? null : authorData.photoURL || null,
                content: content || '',
                timestamp: FieldValue.serverTimestamp(),
                isAnonymous,
                tags: tags || [],
                mediaUrl: mediaUrl.trim(),
                embedUrl: embedUrl,
                oembedHtml: oembedHtml,
                mediaType: 'video',
                likes: [], dislikes: [], likesCount: 0, dislikesCount: 0,
                echoesInvested: 0, amplifiers: {}, commentsCount: 0,
                trendingScore: 0,
            });

            const rewardAmount = 10;
            transaction.update(authorProfileRef, { tokens: FieldValue.increment(rewardAmount) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(-rewardAmount) });
            }
        });
        return { success: true, momentId: newMomentRef.id, reward: 10 };
    } catch (error) {
        console.error(`Error creating moment for user ${authorId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred while posting your Moment.");
    }
});
exports.getMomentsFeed = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to view Moments.");
    }

    const { lastVisible = null } = request.data;
    const limitSize = 5;

    try {
        // --- THIS IS THE FIX ---
        // The query now specifically filters for documents where mediaType is 'video'.
        // This ensures only Reels-compatible content is sent to the client.
        let query = db.collection(`artifacts/${appId}/public/data/anonymous_entries`)
            .where("mediaType", "==", "video")
            .orderBy("timestamp", "desc")
            .limit(limitSize);

        if (lastVisible) {
            const lastDoc = await db.doc(`artifacts/${appId}/public/data/anonymous_entries/${lastVisible}`).get();
            if (lastDoc.exists) {
                query = query.startAfter(lastDoc);
            }
        }

        const snapshot = await query.get();
        const moments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const newLastVisible = snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1].id : null;

        return { moments, lastVisible: newLastVisible };

    } catch (error) {
        console.error("Error fetching Moments feed:", error);
        throw new HttpsError("internal", "Could not fetch the Moments feed.");
    }
});

// In index.js, REPLACE the entire claimQuestReward function with this one.

exports.claimQuestReward = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const { questId } = request.data;
    const userId = request.auth.uid;

    if (!questId || !questDefinitions[questId]) {
        throw new HttpsError("invalid-argument", "A valid quest ID is required.");
    }

    const quest = questDefinitions[questId];
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        const result = await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userProfileRef);
            if (!userDoc.exists) throw new HttpsError("not-found", "Your user profile not found.");

            const userData = userDoc.data();
            const completedQuests = userData.completedQuests || {};

            // Universal Cooldown/Completion Check
            if (completedQuests[questId]) {
                const lastCompleted = completedQuests[questId].toDate();
                if (quest.type === 'onboarding' || quest.type === 'milestone' || quest.type === 'monthly' || quest.type === 'annual') {
                    throw new HttpsError("already-exists", "This quest has already been completed.");
                }
                let cooldown = 0;
                if (quest.type === 'daily') cooldown = 22 * 60 * 60 * 1000; // 22 hours
                if (quest.type === 'weekly') cooldown = 6.5 * 24 * 60 * 60 * 1000; // 6.5 days
                if (Date.now() - lastCompleted.getTime() < cooldown) {
                    throw new HttpsError("failed-precondition", "This quest is still on cooldown.");
                }
            }

            let isComplete = false;
            const daily = userData.dailyQuestProgress || {};
            const weekly = userData.weeklyQuestProgress || {};
            const monthly = userData.monthlyQuestProgress || {};
            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));

            // Server-Side Verification Logic
            switch (questId) {
                // Onboarding & Milestones (State-based, some async)
                case 'customize_profile': isComplete = !!(userData.bio || userData.interests?.length > 0); break;
                case 'like_three_whispers': isComplete = (userData.likesGiven || 0) >= 3; break;
                case 'follow_a_user': isComplete = (userData.followingCount || 0) >= 1; break;
                case 'reach_100_reputation': isComplete = (userData.reputationScore || 0) >= 100; break;
                case 'reach_500_reputation': isComplete = (userData.reputationScore || 0) >= 500; break;
                case 'reach_1000_reputation': isComplete = (userData.reputationScore || 0) >= 1000; break;

                // Dailies (Counter-based)
                case 'daily_login': isComplete = true; break; // Claimed just by calling
                case 'amplify_whisper_daily': isComplete = (daily.amplifies || 0) >= 1; break;
                case 'add_star_daily': isComplete = (daily.starsAdded || 0) >= 1; break;
                case 'post_whisper_daily': isComplete = (daily.posts || 0) >= 1; break;
                case 'send_three_messages_daily': isComplete = (daily.messagesSent || 0) >= 3; break;
                case 'open_echo_chamber_daily': isComplete = (daily.echoChambersOpened || 0) >= 1; break;
                case 'react_to_five_comments_daily': isComplete = (daily.reactions || 0) >= 5; break;
                case 'generate_ai_prompt_daily': isComplete = (daily.promptsGenerated || 0) >= 1; break;

                // Weeklies (Counter-based)
                case 'post_three_whispers_weekly': isComplete = (weekly.posts || 0) >= 3; break;
                case 'receive_five_amplifications_weekly': isComplete = (weekly.amplificationsReceived || 0) >= 5; break;
                case 'connect_with_three_users_weekly': isComplete = (weekly.connectionsMade || 0) >= 3; break;
                case 'spend_100_echoes_weekly': isComplete = (weekly.echoesSpent || 0) >= 100; break;
                case 'earn_50_reputation_weekly': isComplete = ((userData.reputationScore || 0) - (weekly.startReputation || userData.reputationScore)) >= 50; break;
                case 'start_constellation_weekly': isComplete = (weekly.constellationsStarted || 0) >= 1; break;
                case 'get_harmony_sync_weekly': isComplete = (weekly.harmonySyncs || 0) >= 1; break;

                // Monthlies (State/Counter-based)
                case 'post_20_whispers_monthly': isComplete = (monthly.posts || 0) >= 20; break;
                case 'maintain_positive_vibe_monthly': isComplete = (userData.vibeScore || 0) > 50; break;
                case 'amplify_10_whispers_monthly': isComplete = (monthly.amplifies || 0) >= 10; break;

                // Meta Quests (Logic based on other completed quests)
                case 'complete_three_daily_quests':
                    const completedDailies = Object.keys(completedQuests).filter(id => {
                        const qDef = questDefinitions[id];
                        return qDef && qDef.type === 'daily' && completedQuests[id].toDate() > startOfDay;
                    });
                    isComplete = completedDailies.length >= 3;
                    break;
                case 'complete_three_weekly_quests':
                    const completedWeeklies = Object.keys(completedQuests).filter(id => {
                        const qDef = questDefinitions[id];
                        return qDef && qDef.type === 'weekly' && completedQuests[id].toDate() > startOfWeek;
                    });
                    isComplete = completedWeeklies.length >= 3;
                    break;

                default: isComplete = false; // Default to false for async checks below
            }

            // Async verifications for quests that require a separate, non-transactional query
            if (['post_first_whisper', 'seal_first_whisper', 'echo_first_whisper', 'join_a_nexus'].includes(questId)) {
                let q;
                if (questId === 'post_first_whisper') q = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).where("authorId", "==", userId).limit(1);
                if (questId === 'seal_first_whisper') q = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).where("authorId", "==", userId).where("isSealed", "==", true).limit(1);
                if (questId === 'echo_first_whisper') q = db.collection(`artifacts/${appId}/public/data/anonymous_entries`).where("authorId", "==", userId).where("isEcho", "==", true).limit(1);
                if (questId === 'join_a_nexus') q = db.collection(`artifacts/${appId}/public/data/nexuses`).where("memberIds", "array-contains", userId).limit(1);
                const snap = await q.get();
                isComplete = !snap.empty;
            }

            if (!isComplete) throw new HttpsError("failed-precondition", "You have not met the requirements for this quest.");

            // Award & Update
            transaction.update(userProfileRef, {
                tokens: FieldValue.increment(quest.reward),
                [`completedQuests.${questId}`]: FieldValue.serverTimestamp()
            });
            return { success: true, reward: quest.reward };
        });
        return result;
    } catch (error) {
        console.error(`Error claiming quest ${questId} for user ${userId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unknown error occurred while claiming your reward.");
    }
});

// In index.js, REPLACE the existing createWhisper function.
exports.createWhisper = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to create a whisper.");
    }
    const { content, tags, mediaUrl, mediaPath, isAnonymous, vibe } = request.data;
    const authorId = request.auth.uid;

    if (!content && !mediaUrl) {
        throw new HttpsError("invalid-argument", "A whisper must have content or media.");
    }

    const ownerId = await getOwnerAccountId();
    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);
    const newWhisperRef = whispersRef.doc();

    let finalMediaPayload = {};

    if (mediaUrl) {
        const isDirectUpload = mediaUrl.includes("firebasestorage.googleapis.com");

        // This logic correctly sets embedUrl for direct uploads
        if (isDirectUpload) {
            finalMediaPayload = {
                mediaUrl: mediaUrl,
                embedUrl: mediaUrl,
                oembedUrl: mediaUrl,
                mediaPath: mediaPath,
                mediaData: { type: 'direct', url: mediaUrl }
            };
        } else {
            const apiKey = process.env.IFRAMELY_API_KEY;
            if (apiKey) {
                try {
                    const encodedUrl = encodeURIComponent(mediaUrl.trim());
                    const iframelyEndpoint = `https://iframe.ly/api/iframely?url=${encodedUrl}&api_key=${apiKey}&iframe=1&lazy=1&omit_script=1`;
                    const response = await fetch(iframelyEndpoint);
                    const data = await response.json();

                    if (data.html) {
                        finalMediaPayload.oembedHtml = data.html;
                    } else if (data.links?.player?.[0]?.href) {
                        finalMediaPayload.embedUrl = data.links.player[0].href;
                    } else {
                        finalMediaPayload.mediaData = {
                            type: 'link_preview', url: data.url || mediaUrl,
                            title: data.meta?.title, description: data.meta?.description,
                            thumbnail: data.links?.thumbnail?.[0]?.href, favicon: data.links?.icon?.[0]?.href,
                        };
                    }
                    finalMediaPayload.mediaUrl = mediaUrl = embedUrl = oembedUrl;
                } catch (e) {
                    console.error("Iframely processing failed:", e);
                    finalMediaPayload = { mediaUrl: mediaUrl, mediaData: { type: 'simple_link', url: mediaUrl } };
                }
            } else {
                finalMediaPayload = { mediaUrl: mediaUrl, mediaData: { type: 'simple_link', url: mediaUrl } };
            }
        }
    }


    try {
        await db.runTransaction(async (transaction) => {
            const authorProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${authorId}`);
            const authorDoc = await transaction.get(authorProfileRef);
            if (!authorDoc.exists) throw new HttpsError("not-found", "Could not find your user profile.");

            const authorData = authorDoc.data();
            const authorName = isAnonymous ? 'Anonymous' : authorData.displayName || 'User';

            transaction.set(newWhisperRef, {
                authorId, authorName,
                authorPhotoURL: isAnonymous ? null : authorData.photoURL || null,
                content: content || '',
                timestamp: FieldValue.serverTimestamp(),
                isAnonymous,
                tags: tags || [],
                vibe: vibe || null,
                ...finalMediaPayload,
                likes: [], dislikes: [], likesCount: 0, dislikesCount: 0,
                echoesInvested: 0, amplifiers: {}, commentsCount: 0,
                isEcho: false, echoedWhisperId: null, trendingScore: 0,
            });

            const rewardAmount = 5;
            const updates = {
                tokens: FieldValue.increment(rewardAmount),
                "dailyQuestProgress.posts": FieldValue.increment(1),
                "weeklyQuestProgress.posts": FieldValue.increment(1),
                "monthlyQuestProgress.posts": FieldValue.increment(1),
            };
            transaction.update(authorProfileRef, updates);

            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(-rewardAmount) });
            }
        });

        return { success: true, whisperId: newWhisperRef.id, reward: 5 };

    } catch (error) {
        console.error(`Error creating whisper for user ${authorId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred while posting your whisper.");
    }
});
// In index.js, REPLACE the existing postToNexus function.
exports.postToNexus = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to post.");
    }
    const { nexusId, content, tags, mediaUrl, mediaPath, isAnonymous, vibe } = request.data; // Added `vibe` and `mediaPath`
    const authorId = request.auth.uid;

    if (!nexusId || (!content && !mediaUrl)) {
        throw new HttpsError("invalid-argument", "A Nexus ID and content or media are required.");
    }

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const memberRef = nexusRef.collection('members').doc(authorId);
    const postRef = nexusRef.collection('posts').doc();

    try {
        await db.runTransaction(async (transaction) => {
            const [memberDoc, authorDoc] = await Promise.all([
                transaction.get(memberRef),
                transaction.get(db.doc(`artifacts/${appId}/public/data/user_profiles/${authorId}`))
            ]);

            if (!memberDoc.exists) throw new HttpsError("permission-denied", "You are not a member of this Nexus.");
            if (!authorDoc.exists) throw new HttpsError("not-found", "Your user profile could not be found.");

            const authorData = authorDoc.data();
            const authorName = isAnonymous ? 'Anonymous Member' : authorData.displayName || 'User';

            transaction.set(postRef, {
                authorId: authorId,
                authorName: authorName,
                authorPhotoURL: isAnonymous ? null : authorData.photoURL || null,
                content: content || '',
                tags: tags || [],
                mediaUrl: mediaUrl || '',
                mediaPath: mediaPath || '', // Added for future consistency
                vibe: vibe || null, // --- THIS IS THE FIX ---
                timestamp: FieldValue.serverTimestamp(),
                isAnonymous: isAnonymous,
                likes: [],
                likesCount: 0,
            });
        });

        return { success: true, postId: postRef.id };
    } catch (error) {
        console.error(`Error posting to Nexus ${nexusId} by user ${authorId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unexpected error occurred while posting to the Nexus.");
    }
});

// NEW Scheduled function to distribute monthly Echo stipends to Pro members
exports.distributeProStipends = onSchedule({ ...functionOptions, schedule: "first day of month 00:00", timeZone: "America/New_York" }, async (event) => {
    console.log("Running scheduled job: DistributeProStipends");

    const stipendAmount = 500; // The monthly reward for subscribers
    const usersRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);
    const proUsersQuery = usersRef.where("proStatus", "==", "active");

    try {
        const snapshot = await proUsersQuery.get();
        if (snapshot.empty) {
            console.log("No active Pro subscribers found. No stipends to distribute.");
            return null;
        }

        const batch = db.batch();
        snapshot.forEach(doc => {
            console.log(`Awarding ${stipendAmount} Echoes to Pro subscriber ${doc.id}.`);
            const userRef = usersRef.doc(doc.id);
            batch.update(userRef, { tokens: FieldValue.increment(stipendAmount) });

            const notificationRef = db.collection(`artifacts/${appId}/users/${doc.id}/notifications`).doc();
            batch.set(notificationRef, {
                type: 'QUEST_COMPLETE',
                message: `Your monthly Harmony Pro stipend of ${stipendAmount} Echoes has arrived! Thank you for your support.`,
                reward: stipendAmount,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
            });
        });

        await batch.commit();
        console.log(`Successfully distributed stipends to ${snapshot.size} Pro subscribers.`);
        return null;

    } catch (error) {
        console.error("Error distributing Pro stipends:", error);
        return null;
    }
});





// NEW Scheduled Function to calculate trending scores
exports.updateTrendingScores = onSchedule({ ...functionOptions, schedule: "every 15 minutes" }, async (event) => {
    console.log("Running scheduled job: updateTrendingScores");
    const whispersRef = db.collection(`artifacts/${appId}/public/data/anonymous_entries`);

    const recentTime = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const snapshot = await whispersRef.where("timestamp", ">=", recentTime).get();

    if (snapshot.empty) {
        console.log("No recent whispers to score.");
        return null;
    }

    const batch = db.batch();
    snapshot.forEach(doc => {
        const whisper = doc.data();
        const hoursAgo = (Date.now() - whisper.timestamp.toDate().getTime()) / (1000 * 60 * 60);

        const timeDecay = Math.exp(-0.05 * hoursAgo);

        const investmentScore = Math.log10((whisper.echoesInvested || 0) + 1) * 10;
        const likeScore = (whisper.likesCount || 0) * 0.5;

        const trendingScore = (investmentScore + likeScore) * timeDecay;

        batch.update(doc.ref, { trendingScore: trendingScore });
    });

    await batch.commit();
    console.log(`Updated trending scores for ${snapshot.size} whispers.`);
    return null;
});
// ADD THIS NEW FUNCTION to index.js
exports.markChatAsRead = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }
    const { chatPartnerId } = request.data;
    const userId = request.auth.uid;

    if (!chatPartnerId) {
        throw new HttpsError("invalid-argument", "A chatPartnerId is required.");
    }

    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        await userProfileRef.update({
            unreadChatPartners: FieldValue.arrayRemove(chatPartnerId)
        });

        const userDoc = await userProfileRef.get();
        const unreadChats = userDoc.data().unreadChatPartners || [];
        if (unreadChats.length === 0) {
            await userProfileRef.update({ hasUnreadMessages: false });
        }

        return { success: true };
    } catch (error) {
        console.error("Error marking chat as read:", error);
        throw new HttpsError("internal", "Could not mark chat as read.");
    }
});


exports.updateCommentReaction = onCall(functionOptions, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in to react.");
    const { entryId, commentId, emoji } = request.data;
    const reactorId = request.auth.uid;
    if (!entryId || !commentId || !emoji) throw new HttpsError("invalid-argument", "Missing required parameters.");

    const commentRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${entryId}/comments/${commentId}`);
    const reactorRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${reactorId}`);
    const vibePointMap = { '❤️': 1, '✨': 2, '🔥': 1, '👎': -2, '😂': 0, '🤔': 0 };
    const pointChange = vibePointMap[emoji] || 0;

    try {
        await db.runTransaction(async (transaction) => {
            const commentDoc = await transaction.get(commentRef);
            if (!commentDoc.exists) throw new HttpsError("not-found", "Comment not found.");
            const authorId = commentDoc.data().authorId;

            transaction.update(commentRef, { [`reactions.${emoji}`]: FieldValue.arrayUnion(reactorId) });
            transaction.update(reactorRef, { "dailyQuestProgress.reactions": FieldValue.increment(1) });

            if (pointChange !== 0 && authorId) {
                const authorProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${authorId}`);
                transaction.update(authorProfileRef, { vibeScore: FieldValue.increment(pointChange) });
            }
        });
        return { success: true };
    } catch (error) {
        console.error("Error in updateCommentReaction:", error);
        throw new HttpsError("internal", "An error occurred while processing your reaction.");
    }
});

// UPGRADED togglePostReaction Function with Vibe Score Logic
exports.togglePostReaction = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }
    const { entryId, authorId, reactionType } = request.data;
    const userId = request.auth.uid;

    if (!entryId || !authorId || !reactionType) {
        throw new HttpsError("invalid-argument", "Missing required parameters.");
    }

    const entryRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${entryId}`);
    const authorProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${authorId}`);
    const reactorProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${userId}`);

    try {
        await db.runTransaction(async (transaction) => {
            const entryDoc = await transaction.get(entryRef);
            if (!entryDoc.exists) throw new HttpsError("not-found", "Post not found.");

            const entryData = entryDoc.data();
            const userLiked = (entryData.likes || []).includes(userId);
            const userDisliked = (entryData.dislikes || []).includes(userId);

            if (reactionType === 'like') {
                if (userLiked) { // Unliking
                    transaction.update(entryRef, { likes: FieldValue.arrayRemove(userId), likesCount: FieldValue.increment(-1) });
                    transaction.update(authorProfileRef, { vibeScore: FieldValue.increment(-1) });
                    transaction.update(reactorProfileRef, { likesGiven: FieldValue.increment(-1) });
                } else { // Liking
                    let vibeChange = 1;
                    let updates = { likes: FieldValue.arrayUnion(userId), likesCount: FieldValue.increment(1) };
                    if (userDisliked) {
                        updates.dislikes = FieldValue.arrayRemove(userId);
                        updates.dislikesCount = FieldValue.increment(-1);
                        vibeChange += 2;
                    }
                    transaction.update(entryRef, updates);
                    transaction.update(authorProfileRef, { vibeScore: FieldValue.increment(vibeChange) });
                    transaction.update(reactorProfileRef, { likesGiven: FieldValue.increment(1) });
                }
            } else if (reactionType === 'dislike') {
                if (userDisliked) { // Undisliking
                    transaction.update(entryRef, { dislikes: FieldValue.arrayRemove(userId), dislikesCount: FieldValue.increment(-1) });
                    transaction.update(authorProfileRef, { vibeScore: FieldValue.increment(2) });
                } else { // Disliking
                    let vibeChange = -2;
                    let updates = { dislikes: FieldValue.arrayUnion(userId), dislikesCount: FieldValue.increment(1) };
                    if (userLiked) {
                        updates.likes = FieldValue.arrayRemove(userId);
                        updates.likesCount = FieldValue.increment(-1);
                        vibeChange += 1;
                        transaction.update(reactorProfileRef, { likesGiven: FieldValue.increment(-1) });
                    }
                    transaction.update(entryRef, updates);
                    transaction.update(authorProfileRef, { vibeScore: FieldValue.increment(vibeChange) });
                }
            }
        });
        return { success: true };
    } catch (error) {
        console.error("Error in togglePostReaction:", error);
        throw new HttpsError("internal", "An error occurred while processing your reaction.");
    }
});

// REPLACE the existing updateRecentChats function with this one.
exports.updateRecentChats = onDocumentWritten("artifacts/{appId}/private_chats/{chatId}/messages/{messageId}", async (event) => {
    if (!event.data.after.exists) return;

    const message = event.data.after.data();
    const fromId = message.from;
    const toId = message.to;
    const chatId = event.params.chatId;

    if (fromId === toId) {
        return;
    }

    const fromProfileSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${fromId}`).get();
    const toProfileSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${toId}`).get();

    if (!fromProfileSnap.exists || !toProfileSnap.exists) {
        console.log(`One or both user profiles not found for chat ${chatId}.`);
        return;
    }

    const fromProfile = fromProfileSnap.data();
    const toProfile = toProfileSnap.data();

    const recentChatForRecipient = {
        partnerId: fromId,
        partnerName: fromProfile.displayName,
        partnerPhotoURL: fromProfile.photoURL,
        lastMessage: message.content,
        timestamp: message.timestamp,
        isRead: false
    };

    const recentChatForSender = {
        partnerId: toId,
        partnerName: toProfile.displayName,
        partnerPhotoURL: toProfile.photoURL,
        lastMessage: message.content,
        timestamp: message.timestamp,
        isRead: true
    };

    const batch = db.batch();

    const recipientChatRef = db.doc(`artifacts/${appId}/users/${toId}/recent_chats/${fromId}`);
    batch.set(recipientChatRef, recentChatForRecipient, { merge: true });

    const senderChatRef = db.doc(`artifacts/${appId}/users/${fromId}/recent_chats/${toId}`);
    batch.set(senderChatRef, recentChatForSender, { merge: true });

    await batch.commit();
    console.log(`Updated recent chat logs for both users in chat: ${chatId}`);
});
// NEW AI-Powered Conversation Starter Function
exports.generateConversationStarter = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in.");
    }
    const { recipientId } = request.data;
    if (!recipientId) {
        throw new HttpsError("invalid-argument", "A recipient ID is required.");
    }

    try {
        const recipientProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${recipientId}`);
        const recipientDoc = await recipientProfileRef.get();

        if (!recipientDoc.exists) {
            throw new HttpsError("not-found", "The user you're trying to message could not be found.");
        }

        const recipientData = recipientDoc.data();
        const interests = recipientData.interests ? recipientData.interests.join(', ') : 'the world around them';
        const bio = recipientData.bio || 'a mysterious person';

        const prompt = `Generate a friendly, open-ended, and slightly playful conversation starter (under 25 words) for someone who has this bio: "${bio}" and is interested in: "${interests}". The starter should be a question.`;

        const { text: starter } = await generateAiContent(prompt);

        if (!starter) {
            throw new HttpsError("internal", "The AI could not think of a conversation starter.");
        }

        return { starter: starter };

    } catch (error) {
        console.error("Error in generateConversationStarter:", error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError("internal", "An unknown error occurred while generating a starter.");
    }
});
// In index.js, REPLACE the existing postAiWhisper function with this one.

exports.postAiWhisper = onSchedule({ ...functionOptions, schedule: "every 2 hours" }, async (event) => {
    console.log("Running scheduled job: postAiWhisper V2");
    try {
        const aiUsersSnapshot = await db.collection(`artifacts/${appId}/public/data/user_profiles`).where("isAI", "==", true).get();
        if (aiUsersSnapshot.empty) {
            console.log("No AI users found to post.");
            return;
        }

        // 1. Fetch live news from the NewsAPI
        const apiKey = process.env.NEWS_API_KEY;
        if (!apiKey) {
            console.error("NEWS_API_KEY secret not configured. Skipping post.");
            return;
        }

        const newsResponse = await fetch(`https://newsapi.org/v2/top-headlines?country=us&pageSize=20&apiKey=${apiKey}`);
        if (!newsResponse.ok) {
            console.error(`NewsAPI request failed with status: ${newsResponse.status}`);
            return;
        }
        const newsData = await newsResponse.json();
        if (!newsData.articles || newsData.articles.length === 0) {
            console.log("No articles returned from NewsAPI.");
            return;
        }

        const randomArticle = newsData.articles[Math.floor(Math.random() * newsData.articles.length)];
        const aiUsers = aiUsersSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        const randomAiUser = aiUsers[Math.floor(Math.random() * aiUsers.length)];

        // 2. Re-engineered prompt for a genuine-feeling opinion
        const prompt = `You are a social media user named "${randomAiUser.displayName}" with this personality: "${randomAiUser.bio}".
        You just read a news headline titled: "${randomArticle.title}".
        Write a short, casual, in-character social media post (under 50 words) giving your opinion or reaction to this headline. Do not just repeat the headline.`;

        const { text: entryContent } = await generateAiContent(prompt);

        if (entryContent) {
            await db.collection(`artifacts/${appId}/public/data/anonymous_entries`).add({
                authorId: randomAiUser.id,
                authorName: randomAiUser.displayName,
                content: entryContent,
                timestamp: FieldValue.serverTimestamp(),
                isAnonymous: true,
                tags: [...(randomAiUser.interests || []), 'news', 'discussion'], // Add relevant tags
                likes: [], dislikes: [], likesCount: 0, dislikesCount: 0,
                isAI: true,
                vibe: null, // AI posts don't have a pre-set vibe
            });
            console.log(`AI whisper posted for ${randomAiUser.displayName} about: ${randomArticle.title}`);
        }
    } catch (e) {
        console.error("Error in postAiWhisper scheduled function:", e);
    }
});


// In index.js, add this entire new scheduled function.

exports.aggregateNotifications = onSchedule({ ...functionOptions, schedule: "every 15 minutes" }, async (event) => {
    console.log("Running scheduled job: aggregateNotifications");
    const now = new Date();
    // Look for notifications in the last 24 hours to aggregate
    const lookbackDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const AGGREGATION_THRESHOLD = 3; // Minimum number of notifications to trigger aggregation

    try {
        const notificationsQuery = db.collectionGroup('notifications')
            .where('read', '==', false)
            .where('aggregated', '==', null) // Ensure we don't re-aggregate
            .where('timestamp', '>=', lookbackDate);

        const snapshot = await notificationsQuery.get();
        if (snapshot.empty) {
            console.log("No recent, unread notifications to aggregate.");
            return null;
        }

        // Group notifications by user, source, and type (e.g., all likes from User A to User B)
        const userGroups = new Map();
        snapshot.forEach(doc => {
            const data = doc.data();
            const recipientId = doc.ref.parent.parent.id;
            // We only aggregate these specific types for now
            if (data.type !== 'LIKE' && data.type !== 'COMMENT') return;

            // Group by a composite key
            const key = `${recipientId}_${data.fromUserId}_${data.type}`;
            if (!userGroups.has(key)) {
                userGroups.set(key, []);
            }
            userGroups.get(key).push({ ref: doc.ref, data: data });
        });

        const batch = db.batch();
        let groupsAggregated = 0;

        for (const [key, notifications] of userGroups.entries()) {
            if (notifications.length >= AGGREGATION_THRESHOLD) {
                groupsAggregated++;
                const [recipientId, fromUserId, type] = key.split('_');

                // Sort to find the latest notification for the timestamp
                notifications.sort((a, b) => b.data.timestamp.toMillis() - a.data.timestamp.toMillis());
                const latestNote = notifications[0].data;

                // Create the new aggregated notification document
                const newNotifRef = db.collection(`artifacts/${appId}/users/${recipientId}/notifications`).doc();
                let newMessage = '';
                if (type === 'LIKE') {
                    newMessage = `and ${notifications.length - 1} others liked your content.`;
                } else if (type === 'COMMENT') {
                    newMessage = `and ${notifications.length - 1} others commented on your content.`;
                }

                batch.set(newNotifRef, {
                    type: `AGGREGATED_${type}`,
                    fromUserId: fromUserId,
                    fromUserName: latestNote.fromUserName,
                    message: newMessage,
                    count: notifications.length,
                    timestamp: latestNote.timestamp,
                    read: false,
                    aggregated: true,
                    navigation: latestNote.navigation // Navigate to the latest relevant item
                });

                // Delete the old individual notifications
                notifications.forEach(note => batch.delete(note.ref));
            }
        }

        if (groupsAggregated > 0) {
            await batch.commit();
            console.log(`Successfully aggregated notifications for ${groupsAggregated} groups.`);
        } else {
            console.log("No groups met the aggregation threshold.");
        }

        return null;

    } catch (error) {
        console.error("Error during aggregateNotifications job:", error);
        return null;
    }
});

// In index.js, add this entire new function for Nexus-wide events.
exports.notifyOnNexusUpdate = onDocumentWritten("artifacts/{appId}/public/data/nexuses/{nexusId}", async (event) => {
    // Only handle updates
    if (!event.data.before.exists || !event.data.after.exists) return null;

    const nexusId = event.params.nexusId;
    const before = event.data.before.data();
    const after = event.data.after.data();

    const batch = db.batch();

    // Event: Nexus Leveled Up
    if (after.level > before.level) {
        const notification = {
            type: 'NEXUS_LEVEL_UP',
            fromUserName: 'Nexus Emissary',
            message: `Your Nexus, ${after.name}, has reached Level ${after.level}!`,
            navigation: { page: 'nexus', params: { nexusId: nexusId } },
            nexusId: nexusId,
            timestamp: FieldValue.serverTimestamp(),
            read: false,
        };

        // Notify ALL members of this achievement
        const memberIds = after.memberIds || [];
        for (const memberId of memberIds) {
            const notifRef = db.collection(`artifacts/${appId}/users/${memberId}/notifications`).doc();
            batch.set(notifRef, notification);
        }
    }

    // Event: A new member joined
    if (after.memberCount > before.memberCount) {
        const newMembers = after.memberIds.filter(id => !before.memberIds.includes(id));
        if (newMembers.length > 0) {
            const newUserProfile = await db.doc(`artifacts/${appId}/public/data/user_profiles/${newMembers[0]}`).get();
            const newUserName = newUserProfile.exists() ? newUserProfile.data().displayName : 'A new member';

            // Post a system message to the Nexus chat instead of a notification
            const chatRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`).collection('chat').doc();
            batch.set(chatRef, {
                from: 'system',
                content: `${newUserName} has joined the Nexus!`,
                timestamp: FieldValue.serverTimestamp(),
            });
        }
    }

    return batch.commit();
});

// In index.js, add this entire new scheduled function.

exports.calculateConnectionStrengths = onSchedule({ ...functionOptions, schedule: "every 24 hours" }, async (event) => {
    console.log("Running scheduled job: calculateConnectionStrengths");
    const usersRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);
    const usersSnapshot = await usersRef.where("isAI", "==", false).get();
    if (usersSnapshot.empty) return null;

    for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const connectionsRef = db.collection(`artifacts/${appId}/users/${userId}/connections`);
        const connectionsSnapshot = await connectionsRef.get();
        if (connectionsSnapshot.empty) continue;

        const batch = db.batch();
        const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

        for (const connDoc of connectionsSnapshot.docs) {
            const targetId = connDoc.id;
            let strengthScore = 0;

            // 1. Score based on private messages
            const chatId = [userId, targetId].sort().join('_');
            const messagesRef = db.collection(`artifacts/${appId}/private_chats/${chatId}/messages`);
            const messagesSnapshot = await messagesRef.where("timestamp", ">=", twoWeeksAgo).get();
            strengthScore += Math.min(messagesSnapshot.size * 2, 50); // 2 points per message, capped at 50

            // 2. Score based on amplifying each other's content
            const userAmplifiedTargetQuery = db.collection(`artifacts/${appId}/public/data/anonymous_entries`)
                .where("authorId", "==", targetId)
                .where(`amplifiers.${userId}`, ">", 0);
            const targetAmplifiedUserQuery = db.collection(`artifacts/${appId}/public/data/anonymous_entries`)
                .where("authorId", "==", userId)
                .where(`amplifiers.${targetId}`, ">", 0);

            const [userAmplifiedSnap, targetAmplifiedSnap] = await Promise.all([userAmplifiedTargetQuery.get(), targetAmplifiedUserQuery.get()]);
            strengthScore += Math.min((userAmplifiedSnap.size + targetAmplifiedSnap.size) * 10, 50); // 10 points per amplify, capped at 50

            // Final score is 0-100
            const finalScore = Math.min(strengthScore, 100);

            batch.update(connectionsRef.doc(targetId), { strength: finalScore });
        }
        await batch.commit();
    }
    console.log("Finished calculating connection strengths.");
    return null;
});
// In index.js, add this entire new function for member change notifications.
exports.notifyOnNexusMemberChange = onDocumentWritten("artifacts/{appId}/public/data/nexuses/{nexusId}/members/{memberId}", async (event) => {
    const { nexusId, memberId } = event.params;
    const before = event.data.before.data();
    const after = event.data.after.data();

    // Event: User was kicked or left
    if (event.data.before.exists && !event.data.after.exists) {
        // We don't notify on leave, but in the future, we could notify the owner.
        // For now, we assume this is a kick.
        const nexusSnap = await db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`).get();
        if (!nexusSnap.exists) return null;

        const notification = {
            type: 'NEXUS_KICK',
            fromUserName: 'Nexus Emissary',
            message: `You have been removed from the Nexus: ${nexusSnap.data().name}.`,
            navigation: { page: 'nexus' }, // General navigation
            timestamp: FieldValue.serverTimestamp(),
            read: false,
        };
        return db.collection(`artifacts/${appId}/users/${memberId}/notifications`).add(notification);
    }

    // Event: User was promoted or demoted
    if (event.data.before.exists && event.data.after.exists && before.role !== after.role) {
        const nexusSnap = await db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`).get();
        if (!nexusSnap.exists) return null;

        const notification = {
            type: 'NEXUS_ROLE_CHANGE',
            fromUserName: 'Nexus Emissary',
            message: `Your role in ${nexusSnap.data().name} has been changed to ${after.role}.`,
            navigation: { page: 'nexus', params: { nexusId: nexusId } },
            nexusId: nexusId,
            timestamp: FieldValue.serverTimestamp(),
            read: false,
        };
        return db.collection(`artifacts/${appId}/users/${memberId}/notifications`).add(notification);
    }

    // Note: We will handle "new member" announcements via a system message in chat
    // to avoid spamming all existing members with notifications.
    return null;
});
// In index.js, REPLACE the entire stripeWebhook function with this definitive version.

// In index.js, REPLACE the entire stripeWebhook function.

exports.stripeWebhook = onRequest({ memory: "512MiB", secrets: ["STRIPE_WEBHOOK_SECRET"] }, async (req, res) => {
    const stripe = getStripeClient();
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        // Using the native rawBody provided by the Cloud Functions environment, which is more reliable.
        if (!req.rawBody) {
            throw new Error("Webhook Error: rawBody is not available.");
        }
        event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
    } catch (err) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }

    const session = event.data.object;
    const userProfileRef = db.collection(`artifacts/${appId}/public/data/user_profiles`);

    try {
        if (event.type === "checkout.session.completed") {
            const { userId, tokensToAdd } = session.metadata;
            const customerId = session.customer;
            if (!userId) throw new Error("Missing userId in session metadata.");

            if (session.mode === 'payment' && tokensToAdd) {
                await userProfileRef.doc(userId).update({ tokens: FieldValue.increment(parseInt(tokensToAdd, 10)) });
            }

            if (session.mode === 'subscription') {
                const subscription = await stripe.subscriptions.retrieve(session.subscription);
                await userProfileRef.doc(userId).update({
                    stripeCustomerId: customerId,
                    proStatus: subscription.status,
                    proTierExpires: new Date(subscription.current_period_end * 1000),
                });
            }
        }

        if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
            const customerId = session.customer;
            const userQuery = await userProfileRef.where("stripeCustomerId", "==", customerId).limit(1).get();
            if (!userQuery.empty) {
                const userId = userQuery.docs[0].id;
                await userProfileRef.doc(userId).update({
                    proStatus: event.data.object.status,
                    proTierExpires: new Date(event.data.object.current_period_end * 1000),
                });
            }
        }
    } catch (dbError) {
        console.error(`Webhook database error for event ${event.id}:`, dbError);
        return res.status(500).send(`Webhook processing error.`);
    }

    res.status(200).send({ received: true });
});



exports.respondToAiChat = onDocumentWritten(`artifacts/${appId}/private_chats/{chatId}/messages/{messageId}`, async (event) => {
    // Only run for new messages from non-AI users
    if (!event.data.after.exists || event.data.before.exists) return null;

    const messageData = event.data.after.data();
    const fromId = messageData.from;
    const toId = messageData.to; // The AI's ID

    // Exit if the message is from the system or an AI, or if the recipient isn't an AI
    if (fromId === 'system' || fromId.startsWith('ai-') || !toId.startsWith('ai-')) {
        return null;
    }

    const chatId = event.params.chatId;
    const costPerResponse = 4;
    const ownerId = await getOwnerAccountId();
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${fromId}`);
    const aiProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${toId}`);

    try {
        // Fetch previous messages to see if this is the first interaction
        const recentMessagesQuery = db.collection(`artifacts/${appId}/private_chats/${chatId}/messages`).orderBy("timestamp", "desc").limit(5);
        const recentMessagesSnap = await recentMessagesQuery.get();
        const isFirstMessage = recentMessagesSnap.docs.filter(doc => doc.data().from === toId).length === 0;

        // --- THIS IS THE FIX: Corrected transaction logic ---
        const transactionResult = await db.runTransaction(async (transaction) => {
            // STEP 1: Perform ALL reads first.
            const userDoc = await transaction.get(userProfileRef);
            const aiProfileDoc = await transaction.get(aiProfileRef);

            // STEP 2: Perform all checks on the read data.
            if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");
            if (!aiProfileDoc.exists) throw new HttpsError("not-found", "AI profile not found.");
            if ((userDoc.data().tokens || 0) < costPerResponse) {
                throw new HttpsError("resource-exhausted", `Not enough Echoes. You need ${costPerResponse}.`);
            }

            // STEP 3: Perform ALL writes last.
            transaction.update(userProfileRef, { tokens: FieldValue.increment(-costPerResponse) });
            if (ownerId) {
                const ownerRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${ownerId}`);
                transaction.update(ownerRef, { tokens: FieldValue.increment(costPerResponse) });
            }

            // STEP 4: Return the data read from the transaction.
            return { userProfile: userDoc.data(), aiProfile: aiProfileDoc.data() };
        });
        // --- END OF FIX ---

        const { userProfile, aiProfile } = transactionResult;

        // Construct and call the AI for a response
        let aiPrompt = `You are a chatbot persona named "${aiProfile.displayName}" with the bio: "${aiProfile.bio}". A user, "${userProfile.displayName}", has sent you the following message. Craft a natural, in-character response. Keep it brief and conversational. User's message: "${messageData.content}"`;

        if (isFirstMessage) {
            aiPrompt = `You are a chatbot persona named "${aiProfile.displayName}" with the bio: "${aiProfile.bio}". A user, "${userProfile.displayName}", has sent you their first message. First, state that responses cost ${costPerResponse} Echoes. Then, respond naturally and in-character to their message. Keep it brief and conversational. User's message: "${messageData.content}"`;
        }

        const { text: aiResponse } = await generateAiContent(aiPrompt);

        if (aiResponse) {
            // Post the AI's response back to the chat
            const messagesCollectionRef = db.collection(`artifacts/${appId}/private_chats/${chatId}/messages`);
            await messagesCollectionRef.add({
                from: toId,
                to: fromId,
                content: aiResponse,
                timestamp: FieldValue.serverTimestamp(),
                read: false,
            });
        }
    } catch (error) {
        console.error(`Error in respondToAiChat for chat ${chatId}:`, error);
        // Refund the user if any part of the process fails AFTER a successful charge.
        // We check for the specific HttpsError code to avoid refunding for other errors.
        if (!(error instanceof HttpsError && error.code === 'resource-exhausted')) {
            await userProfileRef.update({ tokens: FieldValue.increment(costPerResponse) });
        }

        // Send an error message to the user in the chat
        const messagesCollectionRef = db.collection(`artifacts/${appId}/private_chats/${chatId}/messages`);
        await messagesCollectionRef.add({
            from: 'system',
            to: fromId,
            content: `Sorry, I couldn't process that response. Your ${costPerResponse} Echoes have been refunded. (Error: ${error.message})`,
            timestamp: FieldValue.serverTimestamp(),
        });
    }
    return null;
});


exports.sendNexusChatMessage = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to chat.");
    }
    const { nexusId, content } = request.data;
    const authorId = request.auth.uid;

    if (!nexusId || !content || !content.trim()) {
        throw new HttpsError("invalid-argument", "A Nexus ID and message content are required.");
    }

    const nexusRef = db.doc(`artifacts/${appId}/public/data/nexuses/${nexusId}`);
    const memberRef = nexusRef.collection('members').doc(authorId);
    const chatRef = nexusRef.collection('chat').doc();

    const memberDoc = await memberRef.get();
    if (!memberDoc.exists) {
        throw new HttpsError("permission-denied", "You are not a member of this Nexus and cannot send messages.");
    }

    try {
        await chatRef.set({
            from: authorId,
            content: content,
            timestamp: FieldValue.serverTimestamp()
        });
        return { success: true };
    } catch (error) {
        console.error(`Error sending chat message to Nexus ${nexusId} by user ${authorId}:`, error);
        throw new HttpsError("internal", "An unexpected error occurred while sending your message.");
    }
});

// In index.js, add this entire new function.
exports.clearExpiredSpotlight = onSchedule({ ...functionOptions, schedule: "every 1 hours" }, async (event) => {
    console.log("Running scheduled job: clearExpiredSpotlight");
    const spotlightRef = db.doc(`artifacts/${appId}/public/data/app_metadata/current_spotlight`);

    try {
        const spotlightDoc = await spotlightRef.get();
        if (!spotlightDoc.exists) {
            console.log("No spotlight is currently set.");
            return null;
        }

        const spotlightData = spotlightDoc.data();
        const setAt = spotlightData.setAt.toDate();
        const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

        if (setAt < fortyEightHoursAgo) {
            console.log(`Spotlight for whisper ${spotlightData.entryId} has expired. Clearing.`);
            await spotlightRef.delete();
        } else {
            console.log("Current spotlight has not expired yet.");
        }

        return null;
    } catch (error) {
        console.error("Error during clearExpiredSpotlight job:", error);
        return null;
    }
});
// In index.js, add this entire new function for banning users.
exports.banUser = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Authentication is required.");
    }

    const { targetUserId, reason } = request.data;
    const moderatorId = request.auth.uid;

    if (!targetUserId || !reason) {
        throw new HttpsError("invalid-argument", "A target user ID and a reason are required for a ban.");
    }

    // Permission Check: Ensure the caller is a moderator, admin, or owner.
    const moderatorProfileSnap = await db.doc(`artifacts/${appId}/public/data/user_profiles/${moderatorId}`).get();
    const moderatorRole = moderatorProfileSnap.exists ? moderatorProfileSnap.data().role : 'user';
    if (!['moderator', 'admin', 'owner'].includes(moderatorRole)) {
        throw new HttpsError("permission-denied", "You do not have permission to perform this action.");
    }

    try {
        const targetUserRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${targetUserId}`);
        await targetUserRef.update({
            status: 'banned',
            banReason: reason,
            bannedBy: moderatorId,
            bannedAt: FieldValue.serverTimestamp()
        });

        // Optional: Log this significant action
        const logRef = db.collection(`artifacts/${appId}/private/moderation_logs`).doc();
        await logRef.set({
            action: 'ban',
            targetUserId: targetUserId,
            moderatorId: moderatorId,
            reason: reason,
            timestamp: FieldValue.serverTimestamp()
        });

        return { success: true, message: `User ${targetUserId} has been banned.` };

    } catch (error) {
        console.error(`Error banning user ${targetUserId} by moderator ${moderatorId}:`, error);
        throw new HttpsError("internal", "An unexpected error occurred while banning the user.");
    }
});
// In index.js, add this entire new function.
exports.reportContent = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to report content.");
    }
    const { contentId, contentType, reason } = request.data; // contentType can be 'whisper' or 'comment'
    const reporterId = request.auth.uid;

    if (!contentId || !contentType || !reason) {
        throw new HttpsError("invalid-argument", "A content ID, type, and reason are required.");
    }

    const reportRef = db.collection(`artifacts/${appId}/private/reports`).doc();

    try {
        await reportRef.set({
            reporterId: reporterId,
            contentId: contentId,
            contentType: contentType,
            reason: reason,
            status: 'pending', // 'pending', 'resolved', 'dismissed'
            timestamp: FieldValue.serverTimestamp(),
        });

        // Optionally, increment a report count on the content itself
        if (contentType === 'whisper') {
            const whisperRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${contentId}`);
            await whisperRef.update({ reportCount: FieldValue.increment(1) });
        }
        // You can add similar logic for comments if you store them with report counts

        return { success: true, message: "Your report has been submitted for review. Thank you." };

    } catch (error) {
        console.error(`Error submitting report for ${contentType} ${contentId} by user ${reporterId}:`, error);
        throw new HttpsError("internal", "An unexpected error occurred while submitting your report.");
    }
});
// In index.js, REPLACE the existing deleteWhisper function with this one.
exports.deleteWhisper = onCall(functionOptions, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be logged in to delete content.");
    }

    const { whisperId } = request.data;
    const uid = request.auth.uid;

    if (!whisperId) {
        throw new HttpsError("invalid-argument", "A valid whisper ID is required.");
    }

    const whisperRef = db.doc(`artifacts/${appId}/public/data/anonymous_entries/${whisperId}`);
    const userProfileRef = db.doc(`artifacts/${appId}/public/data/user_profiles/${uid}`);

    try {
        const whisperDoc = await whisperRef.get();
        if (!whisperDoc.exists) {
            // If the whisper is already gone, just return success.
            return { success: true, message: "Whisper already deleted." };
        }
        const whisperData = whisperDoc.data();

        const userProfileDoc = await userProfileRef.get();
        const userRole = userProfileDoc.exists ? userProfileDoc.data().role : 'user';

        const isAuthor = whisperData.authorId === uid;
        const canModerate = ['admin', 'owner', 'moderator'].includes(userRole);
        const canHardDelete = ['admin', 'owner'].includes(userRole);

        if (!isAuthor && !canModerate) {
            throw new HttpsError("permission-denied", "You do not have permission to delete this whisper.");
        }

        // --- PERMISSION LOGIC ---
        // Owners/Admins can permanently delete.
        if (canHardDelete) {
            if (whisperData.mediaPath) {
                try {
                    const bucket = getStorage().bucket();
                    await bucket.file(whisperData.mediaPath).delete();
                } catch (storageError) {
                    console.error(`Non-fatal: Failed to delete storage file ${whisperData.mediaPath}. It may have already been deleted.`, storageError);
                }
            }
            await whisperRef.delete();
            return { success: true, message: "Whisper permanently deleted." };
        }

        // Authors and Moderators can "soft delete" (hide).
        if (isAuthor || canModerate) {
            await whisperRef.update({ isHidden: true, isFlagged: false });
            return { success: true, message: "Whisper has been hidden." };
        }

    } catch (error) {
        console.error(`Error deleting whisper ${whisperId} by user ${uid}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "An unknown error occurred while deleting the whisper.");
    }
});