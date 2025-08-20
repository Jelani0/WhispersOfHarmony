/* global __app_id, __initial_auth_token, __firebase_config */
import React, { useState, useEffect, createContext, useContext, useRef, useCallback, useMemo } from 'react';
import { FixedSizeList as List } from 'react-window';
import { loadStripe } from '@stripe/stripe-js';

import { auth as firebaseAuth, db as firestoreDb, storage as firebaseStorage, functions as firebaseFunctions, rtdb } from './firebase-config';
import { ref as rtdbRef, onValue, set, onDisconnect, serverTimestamp as rtdbServerTimestamp } from 'firebase/database';
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, signInWithCustomToken, signInAnonymously } from 'firebase/auth';
import { collection, addDoc, query, where, getDocs, onSnapshot, doc, deleteDoc, updateDoc, setDoc, arrayUnion, arrayRemove, orderBy, limit, startAfter, writeBatch, getDoc, serverTimestamp, increment, deleteField } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import * as LucideIcons from 'lucide-react';
import Particles, { initParticlesEngine } from "@tsparticles/react";
import { loadFull } from "tsparticles";
import ReactPlayer from 'react-player';
import { Doughnut, Bar, Line } from 'react-chartjs-2';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    ArcElement,
    Tooltip,
    Title,
    Legend,
    Filler,
    // --- NEW: Add these two for the line chart ---
    LineElement,
    PointElement,
} from 'chart.js';
// ...
// --- This line registers the components, making them available to the charts. ---
ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    ArcElement,
    Title,
    Tooltip,
    Legend,
    Filler,
    // --- NEW: Add these two here as well ---
    LineElement,
    PointElement
);
// --- Global Constants & Context ---

const fetchAppParameters = async () => {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve({
                worldEvents: [
                    "A new AI tool came out that makes super realistic pictures from just words. It's wild!",
                    "That famous couple, you know, the one everyone thought was perfect? They just announced they're splitting up. Shocker!",
                    "Some digital art piece sold for millions as an NFT. Like, it's just a picture on the internet, but people are going crazy for it.",
                ]
            });
        });
    });
};

const appId = typeof __app_id !== 'undefined' ? __app_id : 'whispers-of-harmony';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const AppContext = createContext(null);
const useAppContext = () => useContext(AppContext);

const TOKEN_COSTS = {
    GENERATE_PROMPT: 20,
    GET_TEASER: 30,
    GET_SIMILAR_ENTRIES: 40,
    PUBLIC_SUMMARY: 30,
    PUBLIC_SENTIMENT: 30,
    JOURNAL_SUMMARY: 40,
    SENTIMENT_ANALYSIS: 40,
    FOLLOW_UP_QUESTION: 30,
    BIO_SUMMARY: 30,
    INTEREST_ANALYSIS: 30,
    CONVERSATION_STARTER: 30,
    REVEAL_AUTHOR: 60,
    MODERATION_CHECK: 0,
    MOOD_INSIGHT: 0,
    VIBE_CHECK: 10,
    CONNECTION_COMPASS: 50,
    BIO_ENHANCER: 15,
    THEMATIC_CLOUD: 40,
    ECHOES_OF_TOMORROW: 20, // <-- ADD THIS LINE
};

const TOKEN_REWARDS = {
    DAILY_BONUS: 10,
    POST_ENTRY: 5,
    LIKE_DISLIKE_ENGAGEMENT: 0.5,
    COMMENT_ENGAGEMENT: 1,
};


const useIframely = () => {
    // Create a ref that we can attach to a DOM element.
    const ref = useRef(null);

    useEffect(() => {
        // This effect runs after the component renders and the ref is attached to the div.
        if (ref.current && window.iframely) {
            // This is the magic command from the documentation.
            // It tells the Iframely script to specifically scan the element
            // this ref is attached to and convert it into a rich embed.
            window.iframely.load(ref.current);
        }
    }, [ref]); // The dependency array ensures this runs when the ref is set.

    // Return the ref so the component can use it.
    return ref;
};



const useApiCooldown = (featureName, cooldownSeconds = 60) => {
    const [isCoolingDown, setIsCoolingDown] = useState(false);
    const [timeLeft, setTimeLeft] = useState(0);
    const storageKey = `cooldown_${ featureName } `;

    useEffect(() => {
        const lastUsed = localStorage.getItem(storageKey);
        if (lastUsed) {
            const timePassed = Date.now() - parseInt(lastUsed, 10);
            const remaining = (cooldownSeconds * 1000) - timePassed;
            if (remaining > 0) {
                setIsCoolingDown(true);
                setTimeLeft(Math.ceil(remaining / 1000));
                const interval = setInterval(() => {
                    setTimeLeft(prev => {
                        if (prev <= 1) {
                            clearInterval(interval);
                            setIsCoolingDown(false);
                            return 0;
                        }
                        return prev - 1;
                    });
                }, 1000);
                return () => clearInterval(interval);
            }
        }
    }, [featureName, cooldownSeconds, storageKey]);

    const startCooldown = useCallback(() => {
        localStorage.setItem(storageKey, Date.now().toString());
        setIsCoolingDown(true);
        setTimeLeft(cooldownSeconds);
        const interval = setInterval(() => {
            setTimeLeft(prev => {
                if (prev <= 1) {
                    clearInterval(interval);
                    setIsCoolingDown(false);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    }, [cooldownSeconds, storageKey]);

    return { isCoolingDown, timeLeft, startCooldown };
};

const useDebounce = (value, delay) => {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => { const h = setTimeout(() => setDebouncedValue(value), delay); return () => clearTimeout(h); }, [value, delay]);
    return debouncedValue;
};

const useFirestoreQuery = (query) => {
    const [data, setData] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    // Using useCallback to memoize the effect's core logic
    const executeQuery = useCallback(() => {
        if (!query) {
            setData([]);
            setIsLoading(false);
            return () => { };
        }

        setIsLoading(true);
        const unsubscribe = onSnapshot(query,
            (snapshot) => {
                const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setData(docs);
                setIsLoading(false);
            },
            (err) => {
                console.error("Firestore query error:", err);
                setError(err);
                setIsLoading(false);
            }
        );
        return () => unsubscribe();
    }, [JSON.stringify(query)]); // Memoize based on the stringified query

    useEffect(() => {
        const unsubscribe = executeQuery();
        return () => unsubscribe();
    }, [executeQuery]);

    return { data, isLoading, error };
};

const extractMediaUrl = (text) => {
    if (!text) return { textWithoutUrl: '', mediaUrl: null };

    // This comprehensive regex looks for URLs from major platforms that ReactPlayer supports.
    const urlRegex = /(https?:\/\/(?:www\.)?(?:instagram\.com|tiktok\.com|facebook\.com|fb\.watch|vimeo\.com|youtube\.com|youtu\.be|soundcloud\.com|dailymotion\.com|twitch\.tv)\/[^\s]+)/;
    const match = text.match(urlRegex);

    if (match && match[0]) {
        const mediaUrl = match[0];
        const textWithoutUrl = text.replace(urlRegex, '').trim();
        return { textWithoutUrl, mediaUrl };
    }

    return { textWithoutUrl: text, mediaUrl: null };
};

// In App.js, REPLACE the existing NotificationToast component with this one.
const NotificationToast = ({ notification, onClose }) => {
    const { LucideIcons, handlePageChange } = useAppContext();
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        setIsVisible(true); // Animate in
        const timer = setTimeout(() => {
            setIsVisible(false); // Animate out
            setTimeout(onClose, 500); // Wait for animation to finish before calling onClose
        }, 5000); // Toast stays for 5 seconds

        return () => clearTimeout(timer);
    }, [notification, onClose]);

    const handleNavigate = () => {
        if (notification.navigation) {
            handlePageChange(notification.navigation.page, notification.navigation.params);
        }
        setIsVisible(false);
        setTimeout(onClose, 500);
    };

    const notificationConfig = {
        'DEFAULT': { icon: LucideIcons.Bell, color: 'text-gray-400' },
        'MESSAGE': { icon: LucideIcons.Mail, color: 'text-blue-400' },
        'COMMENT': { icon: LucideIcons.MessageCircle, color: 'text-green-400' },
        'GIFT': { icon: LucideIcons.Gift, color: 'text-yellow-400' },
        'LIKE': { icon: LucideIcons.Heart, color: 'text-pink-400' },
        'CONNECTION': { icon: LucideIcons.UserPlus, color: 'text-teal-400' },
        'AMPLIFY': { icon: LucideIcons.Flame, color: 'text-yellow-400' },
        'ECHO': { icon: LucideIcons.MessageSquareReply, color: 'text-cyan-400' },
        'QUEST_COMPLETE': { icon: LucideIcons.Award, color: 'text-purple-400' },
        'SEAL_REVEALED': { icon: LucideIcons.Unlock, color: 'text-indigo-400' },
        'CONSTELLATION_GROWTH': { icon: LucideIcons.Sparkles, color: 'text-purple-300' },
        'NEXUS_LEVEL_UP': { icon: LucideIcons.ArrowUpCircle, color: 'text-yellow-400' },
        'NEXUS_ROLE_CHANGE': { icon: LucideIcons.ShieldCheck, color: 'text-sky-400' },
        'NEXUS_KICK': { icon: LucideIcons.UserX, color: 'text-red-400' },
        'NEXUS_MENTION': { icon: LucideIcons.AtSign, color: 'text-green-400' },
    };

    const config = notificationConfig[notification.type] || notificationConfig['DEFAULT'];
    const Icon = config.icon;

    return (
        <div
            onClick={handleNavigate}
            className={`notification-toast ${isVisible ? 'visible' : ''} ${config.color}`}
        >
            <div className="harmonic-glow" />
            <Icon size={24} className="flex-shrink-0 text-white" />
            <div className="ml-4 overflow-hidden">
                <p className="font-bold text-white truncate">{notification.fromUserName}</p>
                <p className="text-sm text-gray-200 truncate italic">"{notification.message}"</p>
            </div>
            <button onClick={(e) => { e.stopPropagation(); setIsVisible(false); setTimeout(onClose, 500); }} className="ml-4 p-1 rounded-full hover:bg-white/10">
                <LucideIcons.X size={16} className="text-gray-300" />
            </button>
        </div>
    );
};




const HoverTooltip = ({ children, text }) => {
    const [show, setShow] = useState(false);
    return (
        <div className="tooltip-container" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
            {children}
            {show && text && <div className="tooltip-box">{text}</div>}
        </div>
    );
};

// In App.js, REPLACE your existing UniversalMediaRenderer with this definitive version.
const UniversalMediaRenderer = ({ entry }) => {
    const { setMediaToView, LucideIcons } = useAppContext();
    const [status, setStatus] = useState('loading');
    const oembedRef = useIframely();

    useEffect(() => {
        setStatus('loading');
    }, [entry?.mediaUrl, entry?.embedUrl, entry?.oembedHtml]);

    const mediaContent = useMemo(() => {
        if (!entry) return null;

        // Priority 1: oEmbed HTML (Instagram, TikTok).
        if (entry.oembedHtml) {
            setStatus('loaded');
            return <div ref={oembedRef} className="player-wrapper" dangerouslySetInnerHTML={{ __html: entry.oembedHtml }} />;
        }

        // Priority 2: Embed URL (YouTube, Vimeo from Iframely).
        if (entry.embedUrl) {
            return (
                <div className="player-wrapper">
                    <iframe src={entry.embedUrl} className="react-player" frameBorder="0" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen title={entry.content || `Embedded Media`} onLoad={() => setStatus('loaded')} onError={() => setStatus('error')} />
                </div>
            );
        }

        // --- THIS IS THE CRITICAL FIX ---
        // Priority 3: Direct Media URL (Our own Firebase Storage uploads).
        // We now check the top-level `mediaUrl` field directly. This will fix all
        // existing and future direct uploads that were showing a black screen.
        if (entry.mediaUrl && ReactPlayer.canPlay(entry.mediaUrl)) {
            const isDirectImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(entry.mediaUrl);
            if (isDirectImage) {
                return <img src={entry.mediaUrl} alt={entry.content || 'User uploaded media'} className="media-container cursor-pointer" onLoad={() => setStatus('loaded')} onError={() => setStatus('error')} onClick={() => setMediaToView({ type: 'direct', url: entry.mediaUrl })} loading="lazy" />;
            }
            // It's a playable video URL (e.g., mp4 from Firebase Storage)
            return (
                <div className="player-wrapper">
                    <ReactPlayer url={entry.mediaUrl} className="react-player" width='100%' height='100%' controls={true} light={true} onReady={() => setStatus('loaded')} onError={() => setStatus('error')} />
                </div>
            );
        }
        // --- END OF FIX ---

        // Priority 4: Link Preview (If it's not a playable URL, it might be a link to an article).
        if (entry.mediaData?.type === 'link_preview') {
            setStatus('loaded');
            const data = entry.mediaData;
            return (
                <a href={data.url} target="_blank" rel="noopener noreferrer" className="link-preview-card">
                    {data.thumbnail && <img src={data.thumbnail} alt={data.title || 'Link preview'} className="link-preview-image" loading="lazy" />}
                    <div className="link-preview-content">
                        <p className="link-preview-title">{data.title || data.url}</p>
                        <p className="link-preview-description">{data.description}</p>
                        <div className="link-preview-footer">
                            {data.favicon && <img src={data.favicon} alt="favicon" className="w-4 h-4 mr-2" />}
                            <span className="link-preview-url">{new URL(data.url).hostname}</span>
                        </div>
                    </div>
                </a>
            );
        }

        // Fallback if no valid media is found after all checks.
        const timer = setTimeout(() => setStatus('error'), 200);
        return () => clearTimeout(timer);

    }, [entry, setMediaToView, oembedRef]);

    if (!entry || (!entry.mediaUrl && !entry.embedUrl && !entry.oembedHtml && !entry.mediaData)) {
        return null;
    }

    return (
        <div className="relative mt-3">
            {status === 'loading' && (
                <div className="player-wrapper bg-gray-800/50 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-400"></div>
                </div>
            )}
            {status === 'error' && (
                <div className="player-wrapper bg-red-900/20 border border-red-500/50 flex flex-col items-center justify-center text-red-400">
                    <LucideIcons.AlertTriangle size={32} />
                    <p className="mt-2 text-sm font-semibold">Media could not be loaded.</p>
                </div>
            )}
            <div style={{ display: status === 'loaded' ? 'block' : 'none' }}>
                {mediaContent}
            </div>
        </div>
    );
};
const SplashScreen = () => {
    return (
        <div className="splash-screen-container">
            <div className="harmony-orb" />
            <h1 className="splash-title">Whispers of Harmony</h1>
            <p className="splash-loading-text">Tuning the Cosmos...</p>
        </div>
    );
};
// In App.js, REPLACE the existing LoadingSpinner component with this one.

const LoadingSpinner = React.memo(({ message = "Loading..." }) => (
    <div className="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-sm flex flex-col justify-center items-center z-50">
        <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-white"></div>
        <p className="mt-4 text-lg text-white font-semibold tracking-wider">{message}</p>
    </div>
));

const UserHoverCard = ({ profile, position, style }) => {
    if (!profile) return null;
    return (
        <div className="user-hover-card" style={{ top: position.top, left: position.left, ...style }}>
            <img src={profile.photoURL || "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U"} alt={profile.displayName} className="w-10 h-10 rounded-full object-cover border-2 border-gray-600" />
            <div>
                <p className="font-bold text-sm text-white">{profile.displayName}</p>
                <p className="text-xs text-gray-400">{profile.interests?.slice(0, 2).join(', ') || 'Exploring the cosmos'}</p>
            </div>
        </div>
    );
};


const MessageBox = ({ message, onClose, onConfirm, showConfirm = false }) => (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex justify-center items-center z-50">
        <div className="bg-gray-800 bg-opacity-90 p-6 rounded-lg shadow-xl max-w-sm w-full text-center">
            <p className="text-lg font-semibold mb-4 text-blue-200">{message}</p>
            <div className="flex justify-center space-x-4">
                <button onClick={onClose} className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition duration-300">{showConfirm ? 'Cancel' : 'OK'}</button>
                {showConfirm && (<button onClick={onConfirm} className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition duration-300">Confirm</button>)}
            </div>
        </div>
    </div>
);

const AIGeneratedContentModal = ({ title, content, onClose, LucideIcons }) => {
    const modalRef = useRef(null);
    useEffect(() => {
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'Tab' && modalRef.current) {
                const focusableElements = modalRef.current.querySelectorAll('button');
                const firstElement = focusableElements[0];
                const lastElement = focusableElements[focusableElements.length - 1];
                if (event.shiftKey) { if (document.activeElement === firstElement) { lastElement.focus(); event.preventDefault(); } }
                else { if (document.activeElement === lastElement) { firstElement.focus(); event.preventDefault(); } }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        modalRef.current?.querySelector('button')?.focus();
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    if (!content) return null;
    return (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex justify-center items-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="ai-modal-title">
            <div ref={modalRef} className="bg-gray-800 bg-opacity-90 p-6 rounded-lg shadow-xl max-w-md w-full text-white relative">
                <h3 id="ai-modal-title" className="text-xl font-bold mb-4 text-blue-300 font-playfair">{title}</h3>
                <p className="text-lg mb-6 leading-relaxed custom-scrollbar max-h-60 overflow-y-auto"><MarkdownRenderer>{content}</MarkdownRenderer></p>
                <button onClick={onClose} className="absolute top-3 right-3 p-2 rounded-full bg-gray-700 hover:bg-gray-600 text-white transition duration-300" aria-label="Close"><LucideIcons.X size={20} /></button>
            </div>
        </div>
    );
};

const MarkdownRenderer = React.memo(({ children }) => {
    const renderText = (text) => {
        let html = String(text).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/\n/g, '<br />');
        return <span dangerouslySetInnerHTML={{ __html: html }} />;
    };
    return renderText(children);
});

class ErrorBoundary extends React.Component {
    state = { hasError: false, error: null, errorInfo: null };
    static getDerivedStateFromError(error) { return { hasError: true, error }; }
    componentDidCatch(error, errorInfo) { console.error("ErrorBoundary caught an error:", error, errorInfo); this.setState({ errorInfo }); }
    render() {
        if (this.state.hasError) return (<div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-red-100 to-orange-100 text-red-800 p-4"><h2 className="text-3xl font-bold mb-4">Oops! Something went wrong.</h2><p className="text-lg text-center mb-4">We're sorry, but an unexpected error occurred. Please try refreshing the page.</p>{this.props.showDetails && (<details className="mt-4 p-4 bg-red-50 rounded-lg text-sm text-left max-w-lg overflow-auto"><summary className="font-semibold cursor-pointer">Error Details</summary><pre className="mt-2 whitespace-pre-wrap break-all">{this.state.error && this.state.error.toString()}<br />{this.state.errorInfo && this.state.errorInfo.componentStack}</pre></details>)}</div>);
        return this.props.children;
    }
}

function AuthButton({ setCurrentPage }) {
    const { user, signInWithGoogle, signOutUser, LucideIcons } = useAppContext();
    const [message, setMessage] = useState('');
    const handleSignIn = useCallback(async () => { try { await signInWithGoogle(); setMessage('Successfully signed in with Google!'); } catch (e) { console.error("Error signing in with Google:", e); setMessage(`Error signing in: ${ e.message } `); } }, [signInWithGoogle]);
    const handleSignOut = useCallback(async () => { try { await signOutUser(); setMessage('Successfully signed out!'); setCurrentPage('anonymousFeed'); } catch (e) { console.error("Error signing out:", e); setMessage(`Error signing out: ${ e.message } `); } }, [signOutUser, setCurrentPage]);
    return (<>{message && <MessageBox message={message} onClose={() => setMessage('')} />}{user ? (<button onClick={handleSignOut} className="cloud-button bg-red-500 hover:bg-red-600" aria-label="Sign out"><LucideIcons.LogOut size={20} /><span className="text-xs mt-1">Sign Out</span></button>) : (<button onClick={handleSignIn} className="cloud-button bg-blue-500 hover:bg-blue-600" aria-label="Sign in with Google"><LucideIcons.LogIn size={20} /><span className="text-xs mt-1">Sign In</span></button>)}</>);
}

const WhisperInSpace = ({ whisper, onClose }) => {
    const { userId, userProfiles, db, doc, updateDoc, arrayUnion, updateUserTokens, appId } = useAppContext();
    const [isBlooming, setIsBlooming] = useState(false);
    const bloomTimeout = useRef(null);
    const handleReactionMouseDown = () => { setIsBlooming(true); bloomTimeout.current = setTimeout(() => { handleReactionMouseUp(true); }, 1500); };
    const handleReactionMouseUp = async (isFullBloom = false) => {
        clearTimeout(bloomTimeout.current);
        if (!isBlooming) return;
        const emoji = isFullBloom ? '✨' : '❤️';
        const cost = isFullBloom ? 1 : 0;
        const currentUser = userProfiles.find(p => p.id === userId);
        if (currentUser.tokens < cost) { setIsBlooming(false); return; }
        if (cost > 0) await updateUserTokens(userId, -cost);
        const whisperRef = doc(db, `artifacts / ${ appId } /public/data / anonymous_entries`, whisper.id);
        await updateDoc(whisperRef, { [`reactions.${ emoji } `]: arrayUnion(userId) });
        setIsBlooming(false);
        onClose();
    };
    if (!whisper) return null;
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-fadeIn" onClick={onClose}>
            <div className="bg-gray-900/80 backdrop-blur-md p-6 rounded-lg shadow-glow max-w-md w-full border border-blue-500/50 text-center" onClick={e => e.stopPropagation()}>
                <p className="text-lg italic text-gray-200 leading-relaxed">"{whisper.content}"</p>
                <p className="text-right text-sm text-blue-300 mt-4">- {whisper.authorName}</p>
                <div className="mt-6 flex justify-center">
                    <button onMouseDown={handleReactionMouseDown} onMouseUp={() => handleReactionMouseUp(false)} onTouchStart={handleReactionMouseDown} onTouchEnd={() => handleReactionMouseUp(false)} className="relative flex items-center justify-center w-20 h-20 bg-pink-500/20 rounded-full border-2 border-pink-500/50 transition-transform hover:scale-110">
                        <div className={`absolute inset - 0 bg - pink - 400 rounded - full transition - all duration - [1500ms] ease - linear ${ isBlooming ? 'scale-100 opacity-50' : 'scale-0 opacity-0' } `}></div>
                        <LucideIcons.Heart size={32} className="text-pink-400 z-10" />
                    </button>
                </div>
                <p className="text-xs text-gray-400 mt-2">Tap to Like, Hold for a Super Reaction (1 Echo)</p>
            </div>
        </div>
    );
};

// In App.js, REPLACE the existing MusicPlayer component with this one.
const MusicPlayer = ({ LucideIcons }) => {
    const audioRef = useRef(null);
    const [volume, setVolume] = useState(0.1);
    const [isPlaying, setIsPlaying] = useState(false); // Default to false
    const [isMuted, setIsMuted] = useState(false);
    const [hasInteracted, setHasInteracted] = useState(false); // Track first user interaction

    const playAudio = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.play().catch((e) => console.log("Audio playback requires user interaction."));
        }
    }, []);

    useEffect(() => {
        const handleInteraction = () => {
            if (!hasInteracted) {
                setHasInteracted(true);
                setIsPlaying(true); // Autoplay only after the first interaction
                playAudio();
            }
            window.removeEventListener('click', handleInteraction);
            window.removeEventListener('keydown', handleInteraction);
        };

        window.addEventListener('click', handleInteraction);
        window.addEventListener('keydown', handleInteraction);

        return () => {
            window.removeEventListener('click', handleInteraction);
            window.removeEventListener('keydown', handleInteraction);
        };
    }, [hasInteracted, playAudio]);

    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden) {
                audioRef.current?.pause();
            } else if (isPlaying) {
                playAudio();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [isPlaying, playAudio]);

    useEffect(() => {
        if (audioRef.current) {
            if (isPlaying) playAudio();
            else audioRef.current.pause();
        }
    }, [isPlaying, playAudio]);

    useEffect(() => { if (audioRef.current) { audioRef.current.volume = volume; audioRef.current.muted = isMuted; } }, [volume, isMuted]);
    const handleVolumeChange = useCallback((e) => { const newVolume = parseFloat(e.target.value); setVolume(newVolume); if (newVolume > 0) setIsMuted(false); }, []);
    const handlePlayPauseToggle = useCallback(() => setIsPlaying(prev => !prev), []);
    const handleMuteToggle = useCallback(() => setIsMuted(prev => !prev), []);
    const VolumeIcon = useMemo(() => { if (isMuted || volume === 0) return LucideIcons.VolumeX; if (volume < 0.5) return LucideIcons.Volume1; return LucideIcons.Volume2; }, [isMuted, volume, LucideIcons]);

    return (
        <div className="fixed top-4 left-4 p-2 bg-gray-800 bg-opacity-50 rounded-full flex items-center space-x-2 z-50">
            <audio ref={audioRef} src="https://github.com/Jelani0/WhispersOfHarmony/raw/refs/heads/main/melodyloops-touch-of-hope.mp3" loop />
            <button onClick={handlePlayPauseToggle} className="p-2 rounded-full bg-blue-500 hover:bg-blue-600 text-white transition-colors duration-300">{isPlaying ? <LucideIcons.Pause size={20} /> : <LucideIcons.Play size={20} />}</button>
            <button onClick={handleMuteToggle} className="p-2 rounded-full text-white hover:bg-white/10 transition-colors duration-300"><VolumeIcon size={20} /></button>
            <input type="range" min="0" max="1" step="0.01" value={volume} onChange={handleVolumeChange} className="w-20 h-1 rounded-lg appearance-none cursor-pointer bg-gray-700 accent-blue-500" title="Volume Control" />
        </div>
    );
};

function AuraChamber({ onClose }) {
    const { LucideIcons, appFunctions, setMessage } = useAppContext();
    const [state, setState] = useState('ANALYZING');
    const [insight, setInsight] = useState(null);
    useEffect(() => {
        const fetchInsight = async () => {
            const getAuraInsight = httpsCallable(appFunctions, 'getAuraInsight');
            try {
                const result = await getAuraInsight();
                setInsight(result.data);
                setState('REVEALED');
            } catch (error) {
                console.error("Error fetching aura insight:", error);
                setMessage(`Aura analysis failed: ${ error.message } `);
                onClose();
            }
        };
        fetchInsight();
    }, [appFunctions, setMessage, onClose]);
    const auraColor = insight?.color || '#3730a3';
    return (
        <div className="modal-overlay animate-fadeIn" onClick={onClose}>
            <div className="w-full max-w-md text-center relative" onClick={e => e.stopPropagation()}>
                <div className="bg-gray-900/80 backdrop-blur-md p-6 rounded-lg shadow-glow border border-purple-500/50">
                    {state === 'ANALYZING' && (<div className="py-12"><div className="w-24 h-24 rounded-full mx-auto transition-all duration-1000" style={{ backgroundColor: auraColor, boxShadow: `0 0 40px ${ auraColor }, 0 0 80px ${ auraColor } `, animation: 'pulse-slow 2s infinite' }}></div><p className="mt-6 text-lg text-gray-300 animate-pulse">Analyzing your Aura...</p></div>)}
                    {state === 'REVEALED' && insight && (<div className="animate-fadeIn"><div className="w-24 h-24 rounded-full mx-auto mb-4 transition-all duration-1000" style={{ backgroundColor: insight.color, boxShadow: `0 0 40px ${ insight.color }, 0 0 80px ${ insight.color } ` }}></div><h3 className="text-2xl font-bold font-playfair" style={{ color: insight.color }}>{insight.colorName}</h3><p className="text-lg text-gray-300 mb-4">{insight.mood}</p><div className="my-4 border-t border-gray-700/50"></div><p className="text-sm text-gray-400">Key Themes:</p><div className="flex justify-center gap-2 my-2">{insight.themes.map(theme => (<span key={theme} className="bg-gray-700/50 text-gray-200 text-xs font-semibold px-3 py-1 rounded-full">{theme}</span>))}</div><div className="my-4 border-t border-gray-700/50"></div><blockquote className="text-lg italic text-white">"{insight.affirmation}"</blockquote></div>)}
                </div>
                <button onClick={onClose} className="absolute -top-10 right-0 p-2 rounded-full bg-gray-700/50 hover:bg-gray-600/50 text-white transition duration-300" aria-label="Close"><LucideIcons.X size={24} /></button>
            </div>
        </div>
    );
}

function MoodIndicator({ LucideIcons, user, setShowAuraChamber }) {
    const { currentUserProfile, setShowProModal, showConfirmation } = useAppContext();
    const isPro = currentUserProfile?.proStatus === 'active';
    const freeScansUsed = currentUserProfile?.freeAuraScansUsed || 0;

    const handleClick = () => {
        if (!isPro && freeScansUsed >= 1) {
            showConfirmation({
                message: "You've used your free Aura Scan. Upgrade to Harmony Pro for unlimited scans and deeper insights!",
                onConfirm: () => setShowProModal(true)
            });
        } else {
            setShowAuraChamber(true);
        }
    };
    return (<button onClick={handleClick} disabled={!user} className="mood-indicator" title="Open your Aura Chamber"><LucideIcons.Smile size={20} /><span className="text-sm ml-2">My Aura</span></button>);
}

function EchoChamber({ onClose }) {
    const { appFunctions, setMessage, LucideIcons } = useAppContext();
    const [chamberState, setChamberState] = useState('IDLE');
    const [reward, setReward] = useState(null);
    const [error, setError] = useState(null);
    const holdTimeout = useRef(null);

    const handleMouseDown = () => {
        if (chamberState !== 'IDLE') return;
        setChamberState('CHARGING');
        holdTimeout.current = setTimeout(() => {
            openChamber();
        }, 1500);
    };

    const handleMouseUp = () => {
        if (chamberState === 'CHARGING') {
            setChamberState('IDLE');
        }
        clearTimeout(holdTimeout.current);
    };

    const openChamber = async () => {
        setChamberState('REVEALING');
        const openEchoChamber = httpsCallable(appFunctions, 'openEchoChamber');
        try {
            const result = await openEchoChamber();
            setReward(result.data);
            setTimeout(() => setChamberState('REVEALED'), 500);
        } catch (err) {
            console.error("Root cause of chamber failure:", err);
            setError(err.message || "The connection to the forge was unstable. Please try again shortly.");
            setChamberState('ERROR');
        }
    };

    const renderReward = () => {
        if (!reward) return null;
        switch (reward.type) {
            case 'LOST_WHISPER':
                return (
                    <div className="text-center">
                        <h3 className="text-2xl font-bold text-blue-300 mb-2">A Lost Whisper</h3>
                        <p className="text-gray-400 mb-4">A thought from the past that resonates with your own.</p>
                        <div className="bg-black/20 p-4 rounded-lg border border-gray-700 text-left max-h-40 overflow-y-auto custom-scrollbar">
                            <p className="italic">"{reward.data.content}"</p>
                        </div>
                    </div>
                );
            case 'CRYSTAL_BALL_PROMPT':
                return (
                    <div className="text-center">
                        <h3 className="text-2xl font-bold text-purple-300 mb-2">A Crystal Ball Prompt</h3>
                        <p className="text-gray-400 mb-4">A question from the cosmos to inspire your next whisper.</p>
                        <div className="bg-black/20 p-4 rounded-lg border border-gray-700">
                            <p className="text-lg italic">"{reward.data.prompt}"</p>
                        </div>
                    </div>
                );
            case 'ECHO_TROVE':
                return (
                    <div className="text-center">
                        <h3 className="text-2xl font-bold text-yellow-300 mb-2">A Trove of Echoes!</h3>
                        <p className="text-gray-400 mb-4">A burst of creative energy, added to your collection.</p>
                        <p className="text-6xl font-bold text-yellow-400 flex items-center justify-center">
                            <LucideIcons.Flame size={48} className="mr-4" /> +{reward.data.amount}
                        </p>
                    </div>
                );
            case 'HARMONY_CONNECTION':
                return (
                    <div className="text-center">
                        <h3 className="text-2xl font-bold text-green-300 mb-2">A Harmony Connection</h3>
                        <p className="text-gray-400 mb-4">You are not alone in your thoughts. Consider connecting with this user.</p>
                        <div className="bg-black/20 p-4 rounded-lg border border-gray-700 flex items-center justify-center">
                            <img src={reward.data.photoURL || "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U"} alt={reward.data.displayName} className="w-12 h-12 rounded-full mr-4" />
                            <p className="font-bold text-lg">{reward.data.displayName}</p>
                        </div>
                    </div>
                );
            default:
                return <p>An unknown treasure was found!</p>;
        }
    };

    return (
        <div className="modal-overlay animate-fadeIn" onMouseUp={handleMouseUp} onTouchEnd={handleMouseUp}>
            <div className="w-full max-w-md text-center relative">
                <button onClick={onClose} className="absolute -top-8 right-0 p-2 rounded-full bg-gray-700/50 hover:bg-gray-600/50 text-white transition duration-300" aria-label="Close">
                    <LucideIcons.X size={24} />
                </button>

                {chamberState !== 'REVEALED' && chamberState !== 'ERROR' && (
                    <div className="py-8">
                        <div
                            className={`forge - container ${ chamberState === 'CHARGING' ? 'charging' : '' } `}
                            onMouseDown={handleMouseDown}
                            onTouchStart={handleMouseDown}
                        >
                            <div className="forge-crystal"></div>
                        </div>
                        <div className="mt-8 h-10">
                            {chamberState === 'IDLE' && <p className="text-lg text-gray-300">Hold to Forge Your Daily Echo</p>}
                            {chamberState === 'CHARGING' && <p className="text-lg text-purple-300 animate-pulse">Focusing Energy...</p>}
                            {chamberState === 'REVEALING' && <p className="text-lg text-white">Forging...</p>}
                        </div>
                    </div>
                )}

                {chamberState === 'REVEALED' && (
                    <div className="bg-gray-900/80 backdrop-blur-md p-6 rounded-lg shadow-glow border border-purple-500/50 forge-reward-card">
                        {renderReward()}
                        <button onClick={onClose} className="mt-6 px-8 py-2 bg-blue-600 text-white font-bold rounded-full hover:bg-blue-700 transition duration-300">
                            Continue
                        </button>
                    </div>
                )}

                {chamberState === 'ERROR' && (
                    <div className="bg-red-900/20 border border-red-500/50 p-6 rounded-lg forge-reward-card">
                        <h3 className="text-2xl font-bold text-red-400 mb-2">Forge Unstable</h3>
                        <p className="text-gray-300">{error}</p>
                        <button onClick={onClose} className="mt-6 px-8 py-2 bg-gray-600 text-white font-bold rounded-full hover:bg-gray-700 transition duration-300">
                            Close
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function EchoModal({ originalWhisper, onClose }) {
    const { userProfiles, userId, appFunctions, setMessage, LucideIcons } = useAppContext();
    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const currentUserProfile = userProfiles.find(p => p.id === userId);
    const costToEcho = 15;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!content.trim()) {
            setMessage("Your Echo cannot be empty.");
            return;
        }
        if (!currentUserProfile || currentUserProfile.tokens < costToEcho) {
            setMessage(`You need ${ costToEcho } Echoes to post an Echo.`);
            return;
        }

        setIsSubmitting(true);
        const echoWhisper = httpsCallable(appFunctions, 'echoWhisper');
        try {
            await echoWhisper({
                originalWhisperId: originalWhisper.id,
                content: content.trim(),
            });
            setMessage("Your Echo has been posted to the feed!");
            onClose();
        } catch (error) {
            console.error("Error posting Echo:", error);
            setMessage(`Failed to post Echo: ${ error.message } `);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="modal-overlay animate-fadeIn">
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl max-w-lg w-full text-white relative">
                <h3 className="text-xl font-bold mb-2 text-blue-300 font-playfair">Echo this Whisper</h3>
                <p className="text-sm text-gray-400 mb-4">Your response will be posted as a new Whisper, linked to the original.</p>

                <blockquote className="border-l-4 border-purple-400 pl-4 mb-4 text-sm italic text-gray-300 max-h-24 overflow-y-auto custom-scrollbar">
                    "{originalWhisper.content}"
                </blockquote>

                <form onSubmit={handleSubmit}>
                    <textarea
                        className="shadow appearance-none border rounded-lg w-full py-3 px-4 bg-gray-900 text-white leading-tight focus:outline-none focus:ring-2 focus:ring-purple-400 h-32 resize-y"
                        placeholder="Write your Echo here..."
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        required
                    />
                    <div className="flex justify-between items-center mt-4">
                        <p className="text-sm text-yellow-400 font-bold">Cost: {costToEcho} Echoes</p>
                        <button type="submit" disabled={isSubmitting} className="px-6 py-2 bg-purple-600 text-white font-bold rounded-full hover:bg-purple-700 transition duration-300 disabled:opacity-50">
                            {isSubmitting ? "Posting..." : "Post Echo"}
                        </button>
                    </div>
                </form>

                <button onClick={onClose} className="absolute top-3 right-3 p-2 rounded-full bg-gray-700 hover:bg-gray-600 text-white transition duration-300" aria-label="Close">
                    <LucideIcons.X size={20} />
                </button>
            </div>
        </div>
    );
}

function CreateNexusPersonaForm({ nexus, onPersonaCreated }) {
    const { appFunctions, setMessage, showConfirmation, LucideIcons } = useAppContext();
    const [name, setName] = useState('');
    const [bioPrompt, setBioPrompt] = useState('');
    const [interests, setInterests] = useState('');
    const [avatarPrompt, setAvatarPrompt] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const PERSONA_CREATION_COST = 250;

    const handleSubmit = async (e) => {
        e.preventDefault();
        showConfirmation({
            message: `Forging a new AI Persona for ${nexus.name} costs ${PERSONA_CREATION_COST} Echoes. Proceed?`,
            onConfirm: async () => {
                setIsSubmitting(true);
                const createNexusPersona = httpsCallable(appFunctions, 'createNexusPersona');
                try {
                    await createNexusPersona({
                        nexusId: nexus.id,
                        name,
                        bio_prompt: bioPrompt,
                        interests_list: interests.split(',').map(i => i.trim()).filter(Boolean),
                        avatar_prompt: avatarPrompt
                    });
                    setMessage("AI Persona forged successfully!");
                    onPersonaCreated();
                } catch (error) {
                    setMessage(`Failed to forge Persona: ${error.message}`);
                } finally {
                    setIsSubmitting(false);
                }
            }
        });
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg mx-auto animate-fadeIn">
            <h4 className="text-lg font-bold text-center text-purple-200">Forge an AI Persona for <span className="text-white">{nexus.name}</span></h4>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Persona Name (e.g., 'The Archivist')" className="w-full bg-gray-800 p-3 rounded-lg border border-gray-700" required />
            <textarea value={bioPrompt} onChange={e => setBioPrompt(e.target.value)} placeholder="Personality Prompt (e.g., 'A wise old historian who speaks in riddles')" className="w-full bg-gray-800 p-3 rounded-lg border border-gray-700 h-24" required />
            <input type="text" value={interests} onChange={e => setInterests(e.target.value)} placeholder="Interests (e.g., history, secrets, magic)" className="w-full bg-gray-800 p-3 rounded-lg border border-gray-700" required />
            <input type="text" value={avatarPrompt} onChange={e => setAvatarPrompt(e.target.value)} placeholder="Avatar Prompt (e.g., 'a robot with a monocle')" className="w-full bg-gray-800 p-3 rounded-lg border border-gray-700" />
            <button type="submit" disabled={isSubmitting} className="w-full small-action-button bg-purple-600 hover:bg-purple-700 text-lg py-3 disabled:opacity-50">
                {isSubmitting ? "Forging..." : `Forge Persona (${PERSONA_CREATION_COST} Echoes)`}
            </button>
        </form>
    );
}
function NexusPage() {
    const { LucideIcons, currentUserProfile, db, appId, query, collection, where } = useAppContext();
    const [activeTab, setActiveTab] = useState('discover');
    const [selectedNexus, setSelectedNexus] = useState(null); // For the Foundry

    const myOwnedNexusesQuery = useMemo(() => {
        if (!currentUserProfile?.id) return null;
        return query(collection(db, `artifacts/${appId}/public/data/nexuses`), where('ownerId', '==', currentUserProfile.id));
    }, [currentUserProfile, db, appId, query, collection, where]);

    const { data: myOwnedNexuses } = useFirestoreQuery(myOwnedNexusesQuery);

    const isOwner = myOwnedNexuses && myOwnedNexuses.length > 0;

    return (
        <div className="p-4 sm:p-6 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-4xl mx-auto text-white animate-fadeIn">
            <h2 className="text-3xl font-bold text-center mb-6 text-purple-300 font-playfair">Nexus Hub</h2>
            <div className="flex justify-center border-b border-gray-700 mb-6">
                <button onClick={() => setActiveTab('discover')} className={`profile-tab-button ${activeTab === 'discover' ? 'active' : ''}`}>Discover</button>
                <button onClick={() => setActiveTab('my-nexuses')} className={`profile-tab-button ${activeTab === 'my-nexuses' ? 'active' : ''}`}>My Nexuses</button>
                <button onClick={() => setActiveTab('create')} className={`profile-tab-button ${activeTab === 'create' ? 'active' : ''}`}>Create</button>
                {isOwner && <button onClick={() => setActiveTab('foundry')} className={`profile-tab-button ${activeTab === 'foundry' ? 'active' : ''}`}>Foundry</button>}
            </div>
            <div className="page-container">
                {activeTab === 'discover' && <NexusList mode="discover" />}
                {activeTab === 'my-nexuses' && <NexusList mode="mine" />}
                {activeTab === 'create' && <CreateNexusForm onNexusCreated={() => setActiveTab('my-nexuses')} />}
                {activeTab === 'foundry' && isOwner && (
                    <div className="space-y-4">
                        <select
                            onChange={(e) => setSelectedNexus(myOwnedNexuses.find(n => n.id === e.target.value))}
                            className="w-full sm:w-auto bg-gray-800 text-white py-2 px-3 border border-gray-600 rounded-md focus:outline-none"
                        >
                            <option>Select a Nexus to manage...</option>
                            {myOwnedNexuses.map(nexus => <option key={nexus.id} value={nexus.id}>{nexus.name}</option>)}
                        </select>
                        {selectedNexus && <CreateNexusPersonaForm nexus={selectedNexus} onPersonaCreated={() => { }} />}
                    </div>
                )}
            </div>
        </div>
    );
}

function NexusList({ mode }) {
    const { db, appId, userId, collection, query, where, orderBy, limit } = useAppContext();

    const nexusQuery = useMemo(() => {
        if (mode === 'mine') {
            return query(collection(db, `artifacts/${appId}/public/data/nexuses`), where('memberIds', 'array-contains', userId));
        } else { // discover
            return query(collection(db, `artifacts/${appId}/public/data/nexuses`), where('privacy', '==', 'public'), orderBy('memberCount', 'desc'), limit(50));
        }
    }, [mode, collection, limit, orderBy, query, where, db, appId, userId]);

    const { data: nexuses, isLoading } = useFirestoreQuery(nexusQuery);

    if (isLoading) return <LoadingSpinner message="Finding Nexuses..." />;

    return (
        <div className="space-y-4 animate-fadeIn">
            {mode === 'discover' && <NexusFinder />}

            {nexuses.length === 0 ? (
                <p className="text-center text-gray-400 italic py-8">
                    {mode === 'mine' ? "You haven't joined any Nexuses yet. Discover one or create your own!" : "No public Nexuses found. Be the first to create one!"}
                </p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {nexuses.map(nexus => <NexusCard key={nexus.id} nexus={nexus} />)}
                </div>
            )}
        </div>
    );
}

function NexusCard({ nexus }) {
    const { handlePageChange, LucideIcons } = useAppContext();
    return (
        <div
            className="bg-gray-800/70 p-4 rounded-lg flex items-center gap-4 transition-all duration-300 hover:bg-gray-700/90 hover:scale-[1.03] cursor-pointer border border-transparent hover:border-purple-500/50"
            onClick={() => handlePageChange('nexus', { nexusId: nexus.id })}
        >
            <div className="w-16 h-16 rounded-lg flex-shrink-0 relative" style={{ backgroundColor: nexus.nexusColor || '#3730a3' }}>
                <img src={nexus.coverImageURL} alt={nexus.name} className="w-full h-full object-cover rounded-lg opacity-40" />
            </div>
            <div className="flex-grow overflow-hidden">
                <h4 className="font-bold text-white truncate">{nexus.name}</h4>
                <p className="text-sm text-gray-300 truncate">{nexus.description}</p>
                <div className="flex items-center gap-4 text-xs text-gray-400 mt-1">
                    <span className="flex items-center gap-1"><LucideIcons.Users size={12} /> {nexus.memberCount} Members</span>
                    <span className="flex items-center gap-1"><LucideIcons.BarChart size={12} /> Level {nexus.level}</span>
                </div>
            </div>
        </div>
    );
}

function CreateNexusForm({ onNexusCreated }) {
    const { appFunctions, setMessage, showConfirmation } = useAppContext();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [privacy, setPrivacy] = useState('public');
    const [color, setColor] = useState('#6366f1');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const NEXUS_CREATION_COST = 500;

    const handleSubmit = async (e) => {
        e.preventDefault();
        showConfirmation({
            message: `Forging a new Nexus costs ${NEXUS_CREATION_COST} Echoes. This action is permanent. Proceed?`,
            onConfirm: async () => {
                setIsSubmitting(true);
                const createNexus = httpsCallable(appFunctions, 'createNexus');
                try {
                    await createNexus({ name, description, privacy, color });
                    setMessage("Nexus forged successfully!");
                    onNexusCreated();
                } catch (error) {
                    setMessage(`Failed to forge Nexus: ${error.message}`);
                } finally {
                    setIsSubmitting(false);
                }
            }
        });
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg mx-auto animate-fadeIn">
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Nexus Name" className="w-full bg-gray-800 p-3 rounded-lg border border-gray-700 focus:ring-2 focus:ring-purple-500 outline-none" required />
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Nexus Description" className="w-full bg-gray-800 p-3 rounded-lg border border-gray-700 h-24 focus:ring-2 focus:ring-purple-500 outline-none" required />
            <div className="flex items-center justify-between bg-gray-800/50 p-3 rounded-lg">
                <label className="font-bold">Privacy:</label>
                <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer"><input type="radio" value="public" checked={privacy === 'public'} onChange={e => setPrivacy(e.target.value)} className="h-4 w-4 text-purple-500" /> Public</label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="radio" value="private" checked={privacy === 'private'} onChange={e => setPrivacy(e.target.value)} className="h-4 w-4 text-purple-500" /> Private</label>
                </div>
            </div>
            <div className="flex items-center justify-between bg-gray-800/50 p-3 rounded-lg">
                <label htmlFor="nexusColor" className="font-bold">Nexus Color:</label>
                <input type="color" id="nexusColor" value={color} onChange={e => setColor(e.target.value)} className="w-12 h-8 rounded border-none bg-gray-700 cursor-pointer" />
            </div>
            <button type="submit" disabled={isSubmitting} className="w-full small-action-button bg-purple-600 hover:bg-purple-700 text-lg py-3 disabled:opacity-50">
                {isSubmitting ? "Forging..." : `Forge Nexus (${NEXUS_CREATION_COST} Echoes)`}
            </button>
        </form>
    );
}

function NexusHub({ nexusId }) {
    const { appFunctions, setMessage, LucideIcons, handleUserSelect, userId, userProfiles, handlePageChange } = useAppContext();
    const [hubData, setHubData] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('feed');

    const fetchHubData = useCallback(async () => {
        setIsLoading(true); // Always set loading to true when we fetch
        const getNexusHubData = httpsCallable(appFunctions, 'getNexusHubData');
        try {
            const result = await getNexusHubData({ nexusId });
            setHubData(result.data);
        } catch (err) {
            console.error("Error fetching Nexus Hub data:", err);
            setError(err.message);
            if (err.code === 'permission-denied') {
                setTimeout(() => handlePageChange('nexus'), 3000);
            }
        } finally {
            setIsLoading(false);
        }
        // --- THIS IS THE FIX: `hubData` has been removed from the dependency array ---
    }, [nexusId, appFunctions, handlePageChange]);

    useEffect(() => {
        fetchHubData();
    }, [fetchHubData]);

    if (isLoading) return <LoadingSpinner message="Entering Nexus..." />;

    if (error) return <div className="text-center text-red-400 p-8 bg-red-900/20 rounded-lg">Error: {error}</div>;

    // Add a guard for the initial render after loading is false but before data is set.
    if (!hubData || !hubData.nexusData) return <div className="text-center text-gray-400 p-8">Nexus not found or failed to load.</div>;


    const { nexusData, posts, members, chat, activeQuests } = hubData;
    const isMember = nexusData.memberIds?.includes(userId) ?? false;

    return (
        <div className="animate-fadeIn">
            <NexusHeader nexus={nexusData} nexusId={nexusId} />
            <div className="flex justify-center border-b border-gray-700 my-6">
                <button onClick={() => setActiveTab('feed')} className={`profile-tab-button ${activeTab === 'feed' ? 'active' : ''}`}>Feed</button>
                <button onClick={() => setActiveTab('chat')} className={`profile-tab-button ${activeTab === 'chat' ? 'active' : ''}`}>Chat</button>
                <button onClick={() => setActiveTab('projects')} className={`profile-tab-button ${activeTab === 'projects' ? 'active' : ''}`}>Projects</button>
                <button onClick={() => setActiveTab('quests')} className={`profile-tab-button ${activeTab === 'quests' ? 'active' : ''}`}>Quests</button>
                <button onClick={() => setActiveTab('members')} className={`profile-tab-button ${activeTab === 'members' ? 'active' : ''}`}>Members</button>
            </div>
            <div>
                {activeTab === 'feed' && <NexusFeed initialPosts={posts} isMember={isMember} nexusId={nexusId} />}
                {activeTab === 'chat' && <NexusChat initialMessages={chat} isMember={isMember} nexusId={nexusId} />}
                {activeTab === 'projects' && <NexusDreamWeave nexusId={nexusId} />}
                {activeTab === 'quests' && <NexusQuests quests={activeQuests} />}
                {activeTab === 'members' && <NexusMembers members={members} nexus={nexusData} onUserSelect={handleUserSelect} userProfiles={userProfiles} />}
            </div>
        </div>
    );
}

function NexusHeader({ nexus, nexusId }) { // <-- THIS IS THE FIX (Part 2): Receive nexusId prop
    const { LucideIcons, userId, appFunctions, showConfirmation, handlePageChange, setMessage } = useAppContext();
    const isMember = nexus.memberIds?.includes(userId) ?? false;
    const isOwner = nexus.ownerId === userId;
    const [isProcessing, setIsProcessing] = useState(false);

    const handleJoin = async () => {
        setIsProcessing(true);
        const joinNexusFn = httpsCallable(appFunctions, 'joinNexus');
        try {
            await joinNexusFn({ nexusId: nexusId }); // <-- Use the direct prop
            setMessage(`Welcome to ${nexus.name}!`);
        } catch (error) { setMessage(`Failed to join: ${error.message}`); }
        finally { setIsProcessing(false); }
    };

    const handleLeave = () => {
        showConfirmation({
            message: `Are you sure you want to leave ${nexus.name}?`,
            onConfirm: async () => {
                setIsProcessing(true);
                const leaveNexusFn = httpsCallable(appFunctions, 'leaveNexus');
                try {
                    await leaveNexusFn({ nexusId: nexusId }); // <-- Use the direct prop
                    setMessage(`You have left ${nexus.name}.`);
                } catch (error) { setMessage(`Failed to leave: ${error.message}`); }
                finally { setIsProcessing(false); }
            }
        });
    };

    const handleDelete = () => {
        showConfirmation({
            message: `DANGER: This will permanently delete ${nexus.name} and ALL of its content for everyone. This cannot be undone. Proceed?`,
            onConfirm: async () => {
                setIsProcessing(true);
                const deleteNexusFn = httpsCallable(appFunctions, 'deleteNexus');
                try {
                    await deleteNexusFn({ nexusId: nexusId }); // <-- Use the direct prop
                    setMessage(`${nexus.name} has been deleted.`);
                    handlePageChange('nexus');
                } catch (error) { setMessage(`Failed to delete: ${error.message}`); }
                finally { setIsProcessing(false); }
            }
        });
    };

    const luminancePercentage = (nexus.luminance / nexus.luminanceToNextLevel) * 100;
    const aura = nexus.currentAura || { mood: 'New', color: nexus.nexusColor, summary: 'A new Nexus, ready to be shaped.' };

    return (
        <div className="p-4 bg-gray-900/50 rounded-lg shadow-lg border border-purple-500/30 nexus-header-glow">
            <div className="relative h-32 md:h-48 rounded-lg overflow-hidden mb-4">
                <div className="absolute inset-0 nexus-aura-bg" style={{ '--nexus-color': aura.color }}></div>
                <img src={nexus.coverImageURL} alt={nexus.name} className="absolute inset-0 w-full h-full object-cover opacity-20" />
                <div className="absolute bottom-0 left-0 p-4 w-full flex justify-between items-end gap-4">
                    <div className="min-w-0 flex-1"> {/* Allows this container to shrink */}
                        <h2 className="text-3xl md:text-4xl font-bold text-white font-playfair truncate" style={{ textShadow: `0 0 10px ${aura.color}` }}>{nexus.name}</h2>
                    </div>
                    <div className="flex-shrink-0 flex gap-2"> {/* Prevents this container from shrinking */}
                        {isOwner && <button onClick={handleDelete} disabled={isProcessing} className="small-action-button bg-red-800 hover:bg-red-700 text-white"><LucideIcons.Trash2 size={14} /></button>}
                        {isMember ?
                            <button onClick={handleLeave} disabled={isProcessing} className="small-action-button bg-gray-600 hover:bg-gray-500">Leave</button> :
                            <button onClick={handleJoin} disabled={isProcessing} className="small-action-button bg-blue-600 hover:bg-blue-500">Join Nexus</button>
                        }
                    </div>
                </div>
                <div className="absolute top-2 right-2 bg-black/50 px-3 py-1 rounded-full text-sm font-bold" style={{ color: aura.color, border: `1px solid ${aura.color}` }}>
                    {aura.mood}
                </div>
            </div>

            <blockquote className="text-center text-gray-300 italic mb-4 border-l-4 border-r-4 rounded-md p-2" style={{ borderColor: aura.color }}>
                "{aura.summary}"
            </blockquote>

            <div className="px-2">
                <div className="flex justify-between items-center text-sm font-bold mb-1">
                    <span className="text-purple-300">Level {nexus.level}</span>
                    <span className="text-gray-400">{nexus.luminance} / {nexus.luminanceToNextLevel} Luminance</span>
                </div>
                <div className="w-full bg-black/50 rounded-full h-4 border-2 border-purple-900/50 overflow-hidden">
                    <div className="luminance-bar h-full rounded-full" style={{ width: `${luminancePercentage}%` }}></div>
                </div>
            </div>
        </div>
    );
}
// In App.js, add this new reusable component.

const ReactionBar = ({ message, onReact, isUser }) => {
    const { LucideIcons, userId } = useAppContext();
    const [pickerVisible, setPickerVisible] = useState(false);
    const pickerRef = useRef(null);

    const availableEmojis = ['❤️', '😂', '👍', '😢', '🔥'];
    const reactions = message.reactions || {};

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (pickerRef.current && !pickerRef.current.contains(event.target)) {
                setPickerVisible(false);
            }
        };
        if (pickerVisible) document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [pickerVisible]);

    return (
        <div className={`relative flex items-center gap-1 mt-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
            {Object.entries(reactions).map(([emoji, userIds]) => {
                if (userIds && userIds.length > 0) {
                    const userHasReacted = userIds.includes(userId);
                    return (
                        <button
                            key={emoji}
                            onClick={() => onReact(message.id, emoji)}
                            className={`px-2 py-0.5 rounded-full flex items-center gap-1 text-xs transition-colors ${userHasReacted ? 'bg-blue-600 border border-blue-400 text-white' : 'bg-gray-600/50 border border-transparent hover:bg-gray-500/50'}`}
                        >
                            <span>{emoji}</span>
                            <span className="font-semibold">{userIds.length}</span>
                        </button>
                    );
                }
                return null;
            })}

            <div className="relative" ref={pickerRef}>
                <button onClick={() => setPickerVisible(p => !p)} className="p-1 rounded-full text-gray-400 hover:bg-white/10 hover:text-white">
                    <LucideIcons.SmilePlus size={16} />
                </button>
                {pickerVisible && (
                    <div className={`absolute bottom-full mb-2 p-1 bg-gray-900 border border-gray-700 rounded-full flex gap-1 ${isUser ? 'right-0' : 'left-0'}`}>
                        {availableEmojis.map(emoji => (
                            <button
                                key={emoji}
                                onClick={() => { onReact(message.id, emoji); setPickerVisible(false); }}
                                className="p-1.5 rounded-full hover:bg-blue-600/50 transition-transform hover:scale-125"
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
// In App.js, REPLACE the existing NexusChat component with this one.

function NexusChat({ initialMessages, isMember, nexusId }) {
    const { userId, db, collection, serverTimestamp, appId, onSnapshot, query, orderBy, userProfiles, appFunctions, LucideIcons, setMessage } = useAppContext();
    const [messages, setMessages] = useState(initialMessages);
    const [newMessage, setNewMessage] = useState('');
    const [isSending, setIsSending] = useState(false);
    const messagesEndRef = useRef(null);

    useEffect(() => {
        const q = query(collection(db, `artifacts/${appId}/public/data/nexuses/${nexusId}/chat`), orderBy("timestamp", "asc"));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setMessages(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        });
        return () => unsubscribe();
    }, [db, collection, onSnapshot, orderBy, query, appId, nexusId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!newMessage.trim() || isSending) return;

        setIsSending(true);
        const content = newMessage;
        setNewMessage('');

        const sendNexusChatMessage = httpsCallable(appFunctions, 'sendNexusChatMessage');
        try {
            await sendNexusChatMessage({ nexusId, content });
        } catch (error) {
            console.error("Error sending message:", error);
            setNewMessage(content); // Restore message on failure
        } finally {
            setIsSending(false);
        }
    };

    const handleReact = useCallback(async (messageId, emoji) => {
        const reactToNexusMessage = httpsCallable(appFunctions, 'reactToNexusMessage');
        try {
            await reactToNexusMessage({ nexusId, messageId, emoji });
        } catch (error) {
            console.error("Failed to react to nexus message:", error);
            setMessage(`Reaction failed: ${error.message}`);
        }
    }, [appFunctions, nexusId, setMessage]);


    if (!isMember) {
        return <div className="text-center text-gray-400 p-8">You must be a member to participate in the chat.</div>;
    }

    return (
        <div className="flex flex-col h-[60vh] bg-gray-900/50 rounded-lg border border-gray-700/50">
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
                {messages.map((msg) => {
                    const author = userProfiles.find(p => p.id === msg.from);
                    const isUser = msg.from === userId;
                    const isEmissary = msg.from === 'ai-emissary';
                    const isSystem = msg.from === 'system';

                    if (isSystem) {
                        return (
                            <div key={msg.id} className="text-center text-xs text-red-400 bg-red-900/20 rounded-full py-1.5 px-4 my-2 max-w-md mx-auto">
                                {msg.content}
                            </div>
                        );
                    }

                    return (
                        <div key={msg.id}>
                            <div className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
                                {isEmissary ? (
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-purple-500 flex-shrink-0 emissary-avatar">
                                        <LucideIcons.Sparkles size={16} className="text-white" />
                                    </div>
                                ) : (
                                    <img src={author?.photoURL || "https://placehold.co/32x32/AEC6CF/FFFFFF?text=U"} alt={author?.displayName} className="w-8 h-8 rounded-full object-cover" />
                                )}
                                <div className={`max-w-[70%] p-3 rounded-2xl ${isUser ? 'bg-blue-600 text-white rounded-br-md' : isEmissary ? 'bg-purple-900/80 text-gray-200 rounded-bl-md border border-purple-500/50' : 'bg-gray-700 text-gray-100 rounded-bl-md'}`}>
                                    {!isUser && !isEmissary && <p className="text-xs font-bold text-blue-300 mb-1">{author?.displayName}</p>}
                                    {isEmissary && <p className="text-xs font-bold text-purple-300 mb-1">AI Emissary</p>}
                                    <p className="text-sm leading-relaxed break-words"><MarkdownRenderer>{msg.content}</MarkdownRenderer></p>
                                </div>
                            </div>
                            {!isSystem && !isEmissary && (
                                <ReactionBar message={msg} onReact={handleReact} isUser={isUser} />
                            )}
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>
            <div className="p-2 border-t border-gray-700/50">
                <form onSubmit={handleSendMessage} className="flex items-center gap-2">
                    <input type="text" value={newMessage} onChange={e => setNewMessage(e.target.value)} placeholder="Send a message or type '@Emissary help'..." className="flex-1 bg-gray-800 rounded-full py-2 px-4 text-white outline-none" />
                    <button type="submit" disabled={isSending} className="p-2 rounded-full text-purple-400 hover:bg-purple-500/20 disabled:opacity-50"><LucideIcons.Send size={20} /></button>
                </form>
                <p className="text-xs text-gray-500 text-center px-2 pt-1">Invoke the AI for 10 Echoes. Try: <code className="bg-gray-700 p-0.5 rounded">@Emissary summarize</code> or <code className="bg-gray-700 p-0.5 rounded">@Emissary quests</code>.</p>
            </div>
        </div>
    );
}
function NexusMembers({ members, nexus, onUserSelect, userProfiles }) {
    const { LucideIcons, userId, appFunctions, setMessage, showConfirmation } = useAppContext();
    const currentUserMember = members.find(m => m.id === userId);
    const currentUserRole = currentUserMember?.role;

    const handleManageMember = (targetUserId, action) => {
        const targetProfile = userProfiles.find(p => p.id === targetUserId);
        const message = `Are you sure you want to ${action} ${targetProfile.displayName}?`;
        showConfirmation({
            message,
            onConfirm: async () => {
                const manageNexusMembers = httpsCallable(appFunctions, 'manageNexusMembers');
                try {
                    await manageNexusMembers({ nexusId: nexus.id, targetUserId, action });
                    setMessage(`User has been ${action}ed.`);
                } catch (error) {
                    setMessage(`Action failed: ${error.message}`);
                }
            }
        });
    };

    return (
        <div className="space-y-2">
            {members.map(member => {
                const profile = userProfiles.find(p => p.id === member.id);
                if (!profile) return null;

                const canManage = (currentUserRole === 'owner' && member.role !== 'owner') || (currentUserRole === 'moderator' && member.role === 'member');

                return (
                    <div key={member.id} className="bg-gray-800/50 p-3 rounded-lg flex items-center justify-between">
                        <div onClick={() => onUserSelect(member.id)} className="flex items-center gap-3 cursor-pointer">
                            <img src={profile.photoURL || "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U"} alt={profile.displayName} className="w-10 h-10 rounded-full object-cover" />
                            <p className="font-semibold text-white">{profile.displayName}</p>
                        </div>
                        <div className="flex items-center gap-4">
                            {member.role === 'owner' && <span className="text-xs font-bold text-amber-400 flex items-center gap-1"><LucideIcons.Crown size={14} /> Owner</span>}
                            {member.role === 'moderator' && <span className="text-xs font-bold text-sky-400 flex items-center gap-1"><LucideIcons.Shield size={14} /> Moderator</span>}
                            {canManage && (
                                <div className="flex gap-1">
                                    {currentUserRole === 'owner' && member.role === 'member' && <HoverTooltip text="Promote to Moderator"><button onClick={() => handleManageMember(member.id, 'promote')} className="ai-icon-button text-sky-400 hover:bg-sky-900/50"><LucideIcons.ChevronUpSquare size={16} /></button></HoverTooltip>}
                                    {currentUserRole === 'owner' && member.role === 'moderator' && <HoverTooltip text="Demote to Member"><button onClick={() => handleManageMember(member.id, 'demote')} className="ai-icon-button text-gray-400 hover:bg-gray-900/50"><LucideIcons.ChevronDownSquare size={16} /></button></HoverTooltip>}
                                    <HoverTooltip text="Kick from Nexus"><button onClick={() => handleManageMember(member.id, 'kick')} className="ai-icon-button text-red-500 hover:bg-red-900/50"><LucideIcons.XSquare size={16} /></button></HoverTooltip>
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// In App.js, add this entire new component.
function NexusDreamWeave({ nexusId }) {
    const { db, appId, userId, onSnapshot, doc, userProfiles, appFunctions, setMessage, LucideIcons } = useAppContext();
    const [dream, setDream] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [contribution, setContribution] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        const projectRef = doc(db, `artifacts/${appId}/public/data/nexuses/${nexusId}/projects/current_dream`);
        const unsubscribe = onSnapshot(projectRef, (doc) => {
            setDream(doc.exists() ? doc.data() : null);
            setIsLoading(false);
        });
        return () => unsubscribe();
    }, [db, doc, onSnapshot, appId, nexusId]);

    const handleContribute = async (e) => {
        e.preventDefault();
        if (!contribution.trim()) return;
        setIsSubmitting(true);
        const addDreamWeaveContribution = httpsCallable(appFunctions, 'addDreamWeaveContribution');
        try {
            await addDreamWeaveContribution({ nexusId, text: contribution });
            setContribution('');
        } catch (error) {
            setMessage(`Contribution failed: ${error.message}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    const getUserName = (uid) => userProfiles.find(p => p.id === uid)?.displayName || 'A Member';

    if (isLoading) return <LoadingSpinner message="Unfurling the Dream..." />;
    if (!dream) return <div className="text-center text-gray-400 p-8">A new Dream Weave will begin soon.</div>;

    if (dream.status === 'completed') {
        return (
            <div className="p-4 bg-gray-800/50 rounded-lg border border-amber-400/50 animate-fadeIn">
                <h3 className="text-2xl font-bold text-amber-300 font-playfair text-center mb-2">{dream.title}</h3>
                <p className="text-center text-sm text-gray-400 mb-4">A completed Dream Weave by the Nexus.</p>
                <div className="p-4 bg-black/30 rounded-lg max-h-[50vh] overflow-y-auto custom-scrollbar">
                    <p className="whitespace-pre-line leading-relaxed text-gray-200"><MarkdownRenderer>{dream.full_story}</MarkdownRenderer></p>
                </div>
            </div>
        );
    }

    const canContribute = dream.contributions.length === 0 || dream.contributions[dream.contributions.length - 1].userId !== userId;

    return (
        <div className="p-4 bg-gray-800/50 rounded-lg border border-purple-500/50">
            <h3 className="text-xl font-bold text-center text-purple-200 font-playfair">The Dream Weave is Active</h3>
            <div className="my-4 p-4 bg-black/30 rounded-lg text-center">
                <p className="text-sm text-gray-400">AI Inspiration:</p>
                <p className="italic text-lg text-white">"{dream.image_prompt}"</p>
            </div>
            <div className="space-y-3 max-h-[30vh] overflow-y-auto custom-scrollbar p-2">
                <div className="border-l-2 border-purple-400/50 pl-3">
                    <p className="font-bold text-purple-300">The story begins:</p>
                    <p className="text-gray-200 italic">"{dream.opening_line}"</p>
                </div>
                {dream.contributions.map((c, index) => (
                    <div key={index} className="border-l-2 border-gray-600/50 pl-3">
                        <p className="font-bold text-gray-400">{getUserName(c.userId)} adds:</p>
                        <p className="text-gray-200 italic">"{c.text}"</p>
                    </div>
                ))}
            </div>
            <form onSubmit={handleContribute} className="mt-4 border-t border-gray-700/50 pt-4">
                <textarea
                    value={contribution}
                    onChange={e => setContribution(e.target.value)}
                    placeholder={canContribute ? "Add the next part of the story..." : "Waiting for another member to contribute..."}
                    className="w-full bg-gray-900 p-2 rounded-lg border border-gray-700 h-20"
                    disabled={!canContribute || isSubmitting}
                />
                <button type="submit" disabled={!canContribute || isSubmitting} className="w-full small-action-button bg-purple-600 hover:bg-purple-700 mt-2 py-2 disabled:opacity-50">
                    {isSubmitting ? "Weaving..." : "Add to the Dream"}
                </button>
            </form>
        </div>
    );
}

function NexusQuests({ quests }) {
    const { LucideIcons } = useAppContext();
    const questList = Object.values(quests);

    if (questList.length === 0) {
        return <div className="text-center text-gray-400 p-8">This week's Nexus Quests will be revealed soon.</div>;
    }

    return (
        <div className="space-y-4">
            <h3 className="text-xl font-bold text-center text-blue-200 font-playfair">This Week's Quests</h3>
            {questList.map(quest => {
                const progressPercentage = (quest.progress / quest.target) * 100;
                return (
                    <div key={quest.title} className={`p-4 rounded-lg border ${quest.completed ? 'bg-green-900/20 border-green-500/30' : 'bg-gray-800/50 border-gray-700/50'}`}>
                        <div className="flex justify-between items-center">
                            <h4 className="font-bold text-white">{quest.title}</h4>
                            {quest.completed ? (
                                <span className="flex items-center gap-2 text-sm font-bold text-green-400"><LucideIcons.CheckCircle2 size={16} /> Complete</span>
                            ) : (
                                <span className="text-sm font-mono text-gray-400">{quest.progress} / {quest.target}</span>
                            )}
                        </div>
                        <p className="text-sm text-gray-300 mt-1">{quest.description}</p>
                        <div className="w-full bg-black/50 rounded-full h-2.5 mt-3">
                            <div className={`h-2.5 rounded-full ${quest.completed ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${progressPercentage}%` }}></div>
                        </div>
                        <p className="text-right text-xs font-bold text-yellow-400 mt-2">Reward: {quest.luminance} Luminance</p>
                    </div>
                );
            })}
        </div>
    );
}

// In App.js, REPLACE the existing NexusFeed function with this one.

function NexusFeed({ initialPosts, isMember, nexusId }) {
    const { LucideIcons, handleUserSelect, db, appId, query, collection, orderBy, onSnapshot } = useAppContext();
    const [posts, setPosts] = useState(initialPosts);

    useEffect(() => {
        const q = query(collection(db, `artifacts/${appId}/public/data/nexuses/${nexusId}/posts`), orderBy("timestamp", "desc"));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setPosts(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        });
        return () => unsubscribe();
    }, [db, appId, collection, onSnapshot, orderBy, query, nexusId]);

    const NexusPostCard = ({ post }) => (
        <div className="bg-gray-800/50 p-4 rounded-lg border border-gray-700/50">
            <div className="flex items-center gap-3 mb-3">
                <img
                    src={post.authorPhotoURL || "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U"}
                    alt={post.authorName}
                    className="w-10 h-10 rounded-full object-cover cursor-pointer"
                    onClick={() => handleUserSelect(post.authorId)}
                />
                <div>
                    <p className="font-bold text-white cursor-pointer hover:underline" onClick={() => handleUserSelect(post.authorId)}>{post.authorName}</p>
                    {/* --- THIS IS THE FIX --- */}
                    {/* We now check if `post.timestamp` exists before calling `.toDate()`. */}
                    {/* If it doesn't exist yet, we display "Just now". */}
                    <p className="text-xs text-gray-400">{post.timestamp?.toDate ? post.timestamp.toDate().toLocaleString() : 'Just now'}</p>
                    {/* --- END OF FIX --- */}
                </div>
            </div>
            <p className="text-gray-200 italic">"{post.content}"</p>
            <UniversalMediaRenderer entry={post} />
        </div>
    );

    if (!isMember) {
        return <div className="text-center text-gray-400 p-8">You must be a member to view or create posts in this Nexus.</div>;
    }

    return (
        <div className="space-y-4">
            {posts.length > 0 ? (
                posts.map(post => <NexusPostCard key={post.id} post={post} />)
            ) : (
                <div className="text-center text-gray-400 p-8">
                    <LucideIcons.Wind size={48} className="mx-auto mb-4" />
                    <p>The Nexus is quiet. Be the first to share a whisper from the "New Whisper" page.</p>
                </div>
            )}
        </div>
    );
}
// In App.js, REPLACE the existing NexusChat component with this new version.

function AddStarModal({ parentWhisper, onClose }) {
    const { userId, userProfiles, appFunctions, setMessage, LucideIcons } = useAppContext();
    const [content, setContent] = useState('');
    const [modalState, setModalState] = useState('INPUT');
    const [bonus, setBonus] = useState(0);

    const currentUserProfile = userProfiles.find(p => p.id === userId);
    const costToAddStar = 5;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!content.trim()) {
            setMessage("Your whisper cannot be empty.");
            return;
        }

        if (!currentUserProfile || currentUserProfile.tokens < costToAddStar) {
            setMessage(`You need ${costToAddStar} Echoes to add a star.`);
            return;
        }

        setModalState('CASTING');
        const addStarToConstellation = httpsCallable(appFunctions, 'addStarToConstellation');
        try {
            const result = await addStarToConstellation({
                parentWhisperId: parentWhisper.id,
                content: content.trim(),
            });
            setBonus(result.data.bonus);
            setModalState('REVEALED');
        } catch (error) {
            console.error("Error adding star:", error);
            setMessage(`Failed to add star: ${error.message}`);
            setModalState('INPUT');
        }
    };

    return (
        <div className="modal-overlay animate-fadeIn">
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl max-w-lg w-full text-white relative text-center">

                {modalState === 'INPUT' && (
                    <>
                        <h3 className="text-xl font-bold mb-2 text-blue-300 font-playfair">Cast a Whisper into the Cosmos</h3>
                        <p className="text-sm text-gray-400 mb-4">Connect your thought to this Whisper. Cost: 5 Echoes.</p>
                        <blockquote className="border-l-2 border-purple-400 pl-3 mb-4 text-sm italic text-gray-300 max-h-24 overflow-y-auto custom-scrollbar text-left">
                            "{parentWhisper.content}"
                        </blockquote>
                        <form onSubmit={handleSubmit}>
                            <textarea
                                className="shadow appearance-none border rounded-lg w-full py-3 px-4 bg-gray-900 text-white leading-tight focus:outline-none focus:ring-2 focus:ring-purple-400 h-28 resize-y"
                                placeholder="Write your connecting thought here..."
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                required
                            />
                            <div className="flex justify-center items-center mt-4">
                                <button type="submit" className="px-8 py-3 bg-purple-600 text-white font-bold rounded-full hover:bg-purple-700 transition duration-300">
                                    Cast into the Cosmos
                                </button>
                            </div>
                        </form>
                    </>
                )}

                {modalState === 'CASTING' && (
                    <div className="py-12">
                        <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-purple-400 mx-auto"></div>
                        <p className="mt-4 text-lg text-gray-300">Casting your whisper...</p>
                    </div>
                )}

                {modalState === 'REVEALED' && (
                    <div className="py-8 animate-fadeIn">
                        <h3 className="text-2xl font-bold text-yellow-300 font-playfair">Cosmic Echo!</h3>
                        <p className="text-gray-300 mt-2 mb-4">The cosmos answered your whisper.</p>
                        <div className="bg-gray-900/50 p-4 rounded-lg">
                            <p className="text-sm text-gray-400">Your whisper was added to the constellation.</p>
                            <p className="text-5xl font-bold text-yellow-400 my-2">+{bonus}</p>
                            <p className="text-sm text-gray-400">Echoes have been returned to you!</p>
                        </div>
                        <button onClick={onClose} className="mt-6 px-8 py-2 bg-blue-600 text-white font-bold rounded-full hover:bg-blue-700 transition duration-300">
                            Close
                        </button>
                    </div>
                )}

                {modalState !== 'REVEALED' && (
                    <button onClick={onClose} className="absolute top-3 right-3 p-2 rounded-full bg-gray-700 hover:bg-gray-600 text-white transition duration-300" aria-label="Close">
                        <LucideIcons.X size={20} />
                    </button>
                )}
            </div>
        </div>
    );
}

const SealedWhisperCard = ({ entry, getUserDisplayName }) => {
    const { user, userProfiles, appFunctions, setMessage, LucideIcons } = useAppContext();
    const [bidAmount, setBidAmount] = useState(10);
    const [isBidding, setIsBidding] = useState(false);
    const currentUserProfile = userProfiles.find(p => p.id === user?.uid);

    const handleBid = async () => {
        if (!user) { setMessage("Please sign in to bid."); return; }
        if (bidAmount <= 0) { setMessage("Bid must be a positive number."); return; }
        if (currentUserProfile.tokens < bidAmount) { setMessage("You don't have enough Echoes for this bid."); return; }
        setIsBidding(true);
        const bidOnSealedWhisper = httpsCallable(appFunctions, 'bidOnSealedWhisper');
        try {
            await bidOnSealedWhisper({ whisperId: entry.id, amount: bidAmount });
            setMessage(`You successfully bid ${bidAmount} Echoes!`);
        } catch (error) {
            console.error("Error placing bid:", error);
            setMessage(`Bid failed: ${error.message}`);
        } finally {
            setIsBidding(false);
        }
    };

    const unsealDate = entry.unsealTimestamp.toDate();
    const now = new Date();
    const timeLeft = unsealDate > now ? unsealDate - now : 0;
    const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    return (
        <div className="bg-purple-900/20 p-6 rounded-lg shadow-2xl mb-6 border-2 border-purple-400/50 transition-all duration-300 hover:shadow-purple-500/20">
            <div className="flex justify-between items-start mb-3">
                <div>
                    <h3 className="text-xl font-bold text-white font-playfair">{entry.sealTitle}</h3>
                    <p className="text-xs text-gray-400">Sealed by {getUserDisplayName(entry.authorId)} (Reputation: {entry.authorReputationAtSeal})</p>
                </div>
                <div className="text-center bg-black/20 px-3 py-1 rounded-lg">
                    <p className="text-xs text-purple-300">Unseals In</p>
                    <p className="font-bold text-lg text-white">{days}d {hours}h</p>
                </div>
            </div>
            <div className="text-center my-6">
                <p className="text-sm text-gray-400">Total Bid Pool</p>
                <p className="text-5xl font-bold text-yellow-400 flex items-center justify-center">
                    <LucideIcons.Flame size={36} className="mr-3" />
                    {entry.sealBidPool || 0}
                </p>
            </div>
            <div className="flex items-center space-x-2">
                <input type="number" value={bidAmount} onChange={(e) => setBidAmount(Number(e.target.value))} className="shadow appearance-none border rounded-full w-full py-2 px-4 bg-gray-800 text-white leading-tight focus:outline-none focus:ring-2 focus:ring-yellow-400" min="1" />
                <button onClick={handleBid} disabled={isBidding} className="px-6 py-2 bg-yellow-500 text-black font-bold rounded-full hover:bg-yellow-400 transition duration-300 disabled:opacity-50">
                    {isBidding ? "Bidding..." : "Place Bid"}
                </button>
            </div>
        </div>
    );
};
const AccordionItem = ({ title, children, isOpen, onToggle, LucideIcons }) => (
    <div className="border border-gray-700 rounded-lg mb-2">
        <button
            className="flex justify-between items-center w-full p-4 text-lg font-semibold text-gray-100 bg-gray-800 rounded-lg focus:outline-none hover:bg-gray-700 transition duration-300"
            onClick={onToggle}
        >
            {title}
            {isOpen ? <LucideIcons.ChevronUp size={20} /> : <LucideIcons.ChevronDown size={20} />}
        </button>
        {isOpen && (
            <div className="p-4 bg-gray-900 bg-opacity-70 rounded-b-lg">
                {children}
            </div>
        )}
    </div>
);

const useConstellationLayout = (connections, seedId) => {
    const layout = useMemo(() => {
        if (!seedId) return [];
        const seed = seedId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return connections.map((connection, index) => {
            const angle = (index * (137.5 + (seed % 10))) * (Math.PI / 180);
            const radius = 8 * Math.sqrt(index + 1) + (seed % 5);
            const x = 50 + radius * Math.cos(angle);
            const y = 50 + radius * Math.sin(angle);
            const sizeSeed = connection.id.charCodeAt(2) || 1;
            const size = 16 + (sizeSeed % 12);
            return {
                id: connection.id,
                x: Math.max(10, Math.min(90, x)),
                y: Math.max(10, Math.min(90, y)),
                size: size,
                connection,
            };
        });
    }, [connections, seedId]);
    return layout;
};

// In App.js, REPLACE the existing ProactiveSuggestionBanner function with this one.

const ProactiveSuggestionBanner = ({ suggestion }) => {
    const { LucideIcons, handlePageChange, setShowAuraChamber, db, userId, appId, deleteDoc, doc } = useAppContext();

    const handleDismiss = async () => {
        try {
            // CORRECTED: Removed space from the Firestore path string.
            const suggestionRef = doc(db, `artifacts/${appId}/users/${userId}/suggestions/active-suggestion`);
            await deleteDoc(suggestionRef);
        } catch (error) {
            console.error("Failed to dismiss suggestion:", error);
        }
    };

    const handleAction = () => {
        switch (suggestion.type) {
            case 'AURA_SCAN':
                setShowAuraChamber(true);
                break;
            case 'CONNECT_FRIEND':
                handlePageChange('users');
                break;
            case 'TALK_TO_LISTENER':
                handlePageChange('messages');
                break;
            default:
                break;
        }
        handleDismiss();
    };

    const actionConfig = {
        'AURA_SCAN': { text: 'Scan My Aura', icon: LucideIcons.Sparkles },
        'CONNECT_FRIEND': { text: 'Find a Friend', icon: LucideIcons.Users },
        'TALK_TO_LISTENER': { text: 'Talk to Someone', icon: LucideIcons.MessageCircle },
    };

    const config = actionConfig[suggestion.type] || actionConfig['AURA_SCAN'];
    const ActionIcon = config.icon;

    return (
        <div className="suggestion-banner p-4 rounded-lg shadow-lg mb-6 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4">
                <LucideIcons.BrainCircuit size={32} className="text-blue-300 flex-shrink-0" />
                <p className="text-white text-center sm:text-left">{suggestion.message}</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={handleAction} className="small-action-button bg-sky-500 hover:bg-sky-600 text-white">
                    <ActionIcon size={14} className="mr-2" />
                    {config.text}
                </button>
                <button onClick={handleDismiss} className="ai-icon-button text-gray-300 hover:bg-white/10" aria-label="Dismiss suggestion">
                    <LucideIcons.X size={20} />
                </button>
            </div>
        </div>
    );
};


const CardAmplifiers = ({ amplifiers, getUserDisplayName, onUserSelect }) => {
    const [showAmplifiers, setShowAmplifiers] = useState(false);
    const { LucideIcons } = useAppContext();
    if (!amplifiers || amplifiers.length === 0) return null;

    return (
        <div className="mt-4 pt-4 border-t border-gray-700/30">
            <button onClick={() => setShowAmplifiers(!showAmplifiers)} className="text-xs text-yellow-300 flex items-center font-semibold w-full text-left">
                <LucideIcons.Flame size={14} className="mr-1.5" />
                Amplified by {amplifiers.length} {amplifiers.length > 1 ? 'investors' : 'investor'}
                <LucideIcons.ChevronDown size={16} className={`ml-auto transition-transform ${showAmplifiers ? 'rotate-180' : ''}`} />
            </button>
            {showAmplifiers && (
                <div className="mt-2 space-y-1 text-xs pl-4 border-l-2 border-yellow-500/20">
                    {amplifiers.slice(0, 5).map(([id, amount]) => (
                        <p key={id} className="text-gray-400">
                            <span className="font-bold text-gray-300 cursor-pointer hover:underline" onClick={() => onUserSelect(id)}>{getUserDisplayName(id)}</span> invested {amount} Echoes
                        </p>
                    ))}
                    {amplifiers.length > 5 && <p className="text-gray-500 italic">...and {amplifiers.length - 5} more.</p>}
                </div>
            )}
        </div>
    );
};


// In App.js, REPLACE the AnonymousEntryCard and all its related sub-components with this single, complete function.
function AnonymousEntryCard({ entry, userId, getUserDisplayName, handleRevealAuthor, handleGetTeaser, handleGetSimilarEntries, handleLikeToggle, handleDislikeToggle, handleGetPublicSummary, handleGetPublicSentiment, handleGetMoodInsightForEntry, onUserSelect }) {
    const { db, doc, onSnapshot, getDoc, userProfiles, appFunctions, setMessage, appId, showConfirmation, LucideIcons } = useAppContext();
    const [liveEntry, setLiveEntry] = useState(entry);
    const [isAmplifying, setIsAmplifying] = useState(false);
    const [showAddStarModal, setShowAddStarModal] = useState(false);
    const [showConstellationViewer, setShowConstellationViewer] = useState(false);
    const [showEchoModal, setShowEchoModal] = useState(false);
    const [echoedWhisper, setEchoedWhisper] = useState(null);
    const [loadingAction, setLoadingAction] = useState(null);
    const [showComments, setShowComments] = useState(false);

    const currentUserProfile = userProfiles.find(p => p.id === userId);
    const amplifyCost = currentUserProfile?.amplifyCost || 10;
    const { isCoolingDown: isMoodInsightCoolingDown, timeLeft: moodInsightTimeLeft, startCooldown: startMoodInsightCooldown } = useApiCooldown(`entry_mood_${liveEntry.id}`, 300);

    // --- THIS IS THE FIX ---
    // The onSnapshot listener now correctly merges the latest data from Firestore
    // with the existing state. This prevents the `isSpotlight` property, which is
    // passed down as a prop and not stored in Firestore, from being overwritten.
    useEffect(() => {
        const entryRef = doc(db, `artifacts/${appId}/public/data/anonymous_entries`, entry.id);
        const unsubscribe = onSnapshot(entryRef, (docSnap) => {
            if (docSnap.exists()) {
                setLiveEntry(prevEntry => ({
                    ...prevEntry, // Keep existing props like isSpotlight
                    ...docSnap.data(), // Overwrite with the latest live data
                    id: docSnap.id
                }));
            }
        });
        return () => unsubscribe();
    }, [db, appId, doc, onSnapshot, entry.id]);

    useEffect(() => {
        if (liveEntry.isEcho && liveEntry.echoedWhisperId) {
            const fetchEchoedWhisper = async () => {
                const whisperRef = doc(db, `artifacts/${appId}/public/data/anonymous_entries`, liveEntry.echoedWhisperId);
                const whisperSnap = await getDoc(whisperRef);
                if (whisperSnap.exists()) setEchoedWhisper({ id: whisperSnap.id, ...whisperSnap.data() });
            };
            fetchEchoedWhisper();
        } else {
            setEchoedWhisper(null);
        }
    }, [db, liveEntry.isEcho, doc, getDoc, liveEntry.echoedWhisperId, appId]);

    const runAiAction = async (action, handler) => {
        setLoadingAction(action);
        await handler();
        setLoadingAction(null);
    };

    const executeAmplify = useCallback(async () => {
        setIsAmplifying(true);
        const amplifyWhisper = httpsCallable(appFunctions, 'amplifyWhisper');
        try {
            await amplifyWhisper({ whisperId: liveEntry.id, amount: amplifyCost });
            setMessage(`Whisper amplified! You invested ${amplifyCost} Echoes.`);
        } catch (error) {
            setMessage(`Amplification failed: ${error.message}`);
        } finally {
            setIsAmplifying(false);
        }
    }, [appFunctions, liveEntry.id, setMessage, amplifyCost]);

    const executeDelete = useCallback(async () => {
        const deleteWhisper = httpsCallable(appFunctions, 'deleteWhisper');
        try {
            await deleteWhisper({ whisperId: liveEntry.id });
            setMessage("Whisper deleted successfully.");
        } catch (error) {
            setMessage(`Failed to delete whisper: ${error.message}`);
        }
    }, [appFunctions, liveEntry.id, setMessage]);

    const handleGetMoodInsightWithCooldown = useCallback(async () => {
        if (isMoodInsightCoolingDown) {
            setMessage(`Mood Insight is cooling down. Please wait ${moodInsightTimeLeft} seconds.`);
            return;
        }
        await handleGetMoodInsightForEntry(liveEntry.id, liveEntry.content);
        startMoodInsightCooldown();
    }, [isMoodInsightCoolingDown, moodInsightTimeLeft, startMoodInsightCooldown, handleGetMoodInsightForEntry, liveEntry.id, liveEntry.content, setMessage]);

    const handleReport = () => {
        const reason = prompt("Please provide a brief reason for reporting this whisper (e.g., spam, harassment, explicit content).");
        if (reason && reason.trim()) {
            const reportContent = httpsCallable(appFunctions, 'reportContent');
            reportContent({ contentId: liveEntry.id, contentType: 'whisper', reason: reason.trim() })
                .then((result) => setMessage(result.data.message))
                .catch(err => setMessage(`Report failed: ${err.message}`));
        } else if (reason !== null) { // User didn't cancel, but left it empty
            setMessage("A reason is required to submit a report.");
        }
    };


    const cardClasses = useMemo(() => {
        let classes = "bg-white bg-opacity-10 p-4 sm:p-6 rounded-lg shadow-inner mb-6 border transition-all duration-300 hover:shadow-lg";
        if (liveEntry.isSpotlight) {
            return `${classes} spotlight-entry`;
        }
        const echoes = liveEntry.echoesInvested || 0;
        if (echoes >= 1000) classes += ' amplify-tier-3';
        else if (echoes >= 250) classes += ' amplify-tier-2';
        else if (echoes >= 50) classes += ' amplify-tier-1';
        else classes += ' border-gray-700 hover:border-blue-600/50';
        return classes;
    }, [liveEntry.isSpotlight, liveEntry.echoesInvested]);

    if (liveEntry.isSealed) {
        return <SealedWhisperCard entry={liveEntry} getUserDisplayName={getUserDisplayName} />;
    }

    // --- SUB-COMPONENTS (Defined inside for encapsulation) ---

    const RevealedCardHeader = ({ entry, onUserSelect }) => {
        const authorProfile = userProfiles.find(p => p.id === entry.authorId);
        const isPro = authorProfile?.proStatus === 'active';
        return (
            <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-3 cursor-pointer" onClick={() => onUserSelect(entry.authorId)}>
                    <img src={entry.authorPhotoURL || "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U"} alt={entry.authorName} className="w-10 h-10 rounded-full object-cover border-2 border-blue-400" />
                    <div>
                        <div className="flex items-center gap-2">
                            <p className="font-bold text-white hover:underline">{entry.authorName}</p>
                            {isPro && <HoverTooltip text="Harmony Pro Member"><LucideIcons.Crown size={14} className="text-amber-300" /></HoverTooltip>}
                        </div>
                        <p className="text-xs text-gray-400">Whisper revealed by investors</p>
                    </div>
                </div>
                <p className="text-xs text-gray-400">{entry.timestamp?.toDate ? entry.timestamp.toDate().toLocaleString() : 'Just now'}</p>
            </div>
        );
    };
    const CardHeader = ({ entry, getUserDisplayName, onUserSelect }) => {
        const authorProfile = userProfiles.find(p => p.id === entry.authorId);
        const isPro = authorProfile?.proStatus === 'active';
        return (
            <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                    <p className="text-sm text-gray-300 cursor-pointer hover:underline" onClick={() => onUserSelect(entry.authorId)}>{getUserDisplayName(entry.authorId)}</p>
                    {isPro && (<HoverTooltip text="Harmony Pro Member"><LucideIcons.Crown size={14} className="text-amber-300" /></HoverTooltip>)}
                </div>
                <p className="text-xs text-gray-400">{entry.timestamp?.toDate ? entry.timestamp.toDate().toLocaleString() : 'Just now'}</p>
            </div>
        );
    };

    // Inside the AnonymousEntryCard component...
    const CardBody = ({ entry, echoedWhisper, getUserDisplayName }) => {
        if (!entry) return null;
        // Logic is simplified as MediaRenderer now handles extraction
        return (
            <div className="mt-2">
                {echoedWhisper && (
                    <div className="mb-4 p-3 border-l-4 border-cyan-400/50 bg-black/20 rounded-r-lg cursor-pointer hover:bg-black/30">
                        <p className="text-xs text-gray-400 mb-1">Echoing a whisper from {getUserDisplayName(echoedWhisper.authorId)}</p>
                        <p className="text-sm italic text-gray-300 truncate">"{echoedWhisper.content}"</p>
                    </div>
                )}
                {entry.content && (<div className="text-gray-100 text-lg mb-4 italic leading-relaxed"><MarkdownRenderer>{entry.content}</MarkdownRenderer></div>)}

                {/* --- THIS IS THE FIX: Pass the whole entry object --- */}
                <UniversalMediaRenderer entry={entry} />

                {entry.tags?.length > 0 && (<p className="text-sm text-gray-400 my-4">Tags: {entry.tags.map(t => `#${t}`).join(' ')}</p>)}
            </div>
        );
    };

    const CardActions = ({ entry, onShowConstellation, onAddStar, onAmplify, isAmplifying, isAmplifiedByCurrentUser, amplifyCost }) => {
        return (
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mt-4 pt-4 border-t border-gray-700/50 gap-4">
                <div className="flex items-center justify-center sm:justify-start space-x-4 text-sm">
                    <div className="flex items-center text-yellow-400" title="Total Echoes Invested"><LucideIcons.Flame size={16} className="mr-1" /><span>{entry.echoesInvested || 0}</span></div>
                    <div className="flex items-center text-gray-300" title="Likes"><LucideIcons.Heart size={16} className="mr-1" /><span>{entry.likesCount || 0}</span></div>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                    {entry.isSeed && (<button onClick={onShowConstellation} className="small-action-button bg-blue-500 hover:bg-blue-400"><LucideIcons.GitBranchPlus size={16} className="mr-2" />View</button>)}
                    <button onClick={onAddStar} className="small-action-button bg-purple-500 hover:bg-purple-400"><LucideIcons.Plus size={16} className="mr-2" />Add Star</button>
                    <button onClick={onAmplify} disabled={isAmplifying || isAmplifiedByCurrentUser || entry.authorId === userId} className={`small-action-button disabled:opacity-50 disabled:cursor-not-allowed ${isAmplifiedByCurrentUser ? 'bg-green-500 text-white' : 'bg-yellow-500 hover:bg-yellow-400 text-black'}`}>
                        {isAmplifying ? (<div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-black"></div>) : (<><LucideIcons.Flame size={16} className="mr-2" />{isAmplifiedByCurrentUser ? 'Invested' : `Amplify (${amplifyCost})`}</>)}
                    </button>
                </div>
            </div>
        );
    };

    const CardAiMenu = ({ entry, handlers, loadingAction, isMoodInsightCoolingDown, moodInsightTimeLeft }) => {
        const [isMenuOpen, setIsMenuOpen] = useState(false);
        const menuRef = useRef(null);
        useEffect(() => {
            const handleClickOutside = (event) => { if (menuRef.current && !menuRef.current.contains(event.target)) setIsMenuOpen(false); };
            if (isMenuOpen) document.addEventListener("mousedown", handleClickOutside);
            return () => document.removeEventListener("mousedown", handleClickOutside);
        }, [isMenuOpen]);
        return (
            <div className="flex justify-end items-center mt-4 space-x-1 sm:space-x-2">
                <HoverTooltip text="Post a new whisper that links back to this one. Cost: 15 Echoes."><button onClick={handlers.handleEcho} className="ai-icon-button text-cyan-400 hover:bg-cyan-400/20" aria-label="Echo this whisper"><LucideIcons.MessageSquareReply size={20} /></button></HoverTooltip>
                <HoverTooltip text="Like this whisper."><button onClick={() => handlers.handleLikeToggle(entry.id, entry.authorId)} className={`ai-icon-button transition duration-300 ${entry.likes?.includes(userId) ? 'text-pink-500' : 'text-gray-400 hover:text-pink-400'}`} aria-label="Like whisper"><LucideIcons.Heart size={20} /></button></HoverTooltip>
                <HoverTooltip text="Dislike this whisper."><button onClick={() => handlers.handleDislikeToggle(entry.id, entry.authorId)} className={`ai-icon-button transition duration-300 ${entry.dislikes?.includes(userId) ? 'text-blue-500' : 'text-gray-400 hover:text-blue-400'}`} aria-label="Dislike whisper"><LucideIcons.ThumbsDown size={20} /></button></HoverTooltip>
                <div className="relative" ref={menuRef}>
                    <HoverTooltip text="AI Tools & More Actions"><button onClick={() => setIsMenuOpen(!isMenuOpen)} className="ai-icon-button text-yellow-400 hover:bg-yellow-400/20" aria-label="Open AI tools and more actions menu"><LucideIcons.Sparkles size={20} /></button></HoverTooltip>
                    <div className={`absolute bottom-full mb-2 right-0 w-56 bg-gray-900 border border-gray-700 rounded-lg shadow-lg transition-all duration-200 z-20 ${isMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
                        <button onClick={() => showConfirmation({ message: `This action costs Echoes. Proceed?`, onConfirm: () => handlers.runAiAction('summary', () => handlers.handleGetPublicSummary(entry.id, entry.content)) })} disabled={loadingAction} className="flex items-center w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800">{loadingAction === 'summary' ? <div className="action-spinner"></div> : <LucideIcons.MessageSquareQuote size={14} className="mr-2 text-sky-300" />} Get AI Summary</button>
                        <button onClick={() => showConfirmation({ message: `This action costs Echoes. Proceed?`, onConfirm: () => handlers.runAiAction('sentiment', () => handlers.handleGetPublicSentiment(entry.id, entry.content)) })} disabled={loadingAction} className="flex items-center w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800">{loadingAction === 'sentiment' ? <div className="action-spinner"></div> : <LucideIcons.TrendingUp size={14} className="mr-2 text-purple-300" />} Analyze Sentiment</button>
                        <div className="my-1 border-t border-gray-700"></div>
                        <button onClick={() => { setIsMenuOpen(false); handlers.handleReport() }} className="flex items-center w-full text-left px-3 py-2 text-sm text-orange-400 hover:bg-gray-800 font-bold"><LucideIcons.Flag size={14} className="mr-2" /> Report Whisper</button>
                        {(userId === entry.authorId || currentUserProfile?.role === 'admin' || currentUserProfile?.role === 'owner') && (
                            <><div className="my-1 border-t border-gray-700"></div><button onClick={() => { setIsMenuOpen(false); handlers.handleDelete() }} className="flex items-center w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800 font-bold"><LucideIcons.Trash2 size={14} className="mr-2" /> Delete Whisper</button></>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    // --- MAIN COMPONENT RENDER ---

    return (
        <>
            {showConstellationViewer && <ConstellationView seedWhisper={liveEntry} onClose={() => setShowConstellationViewer(false)} />}
            {showAddStarModal && <AddStarModal parentWhisper={liveEntry} onClose={() => setShowAddStarModal(false)} />}
            {showEchoModal && <EchoModal originalWhisper={liveEntry} onClose={() => setShowEchoModal(false)} />}

            <div className={cardClasses}>
                {liveEntry.isAnonymous === false ?
                    <RevealedCardHeader entry={liveEntry} onUserSelect={onUserSelect} /> :
                    <CardHeader entry={liveEntry} getUserDisplayName={getUserDisplayName} onUserSelect={onUserSelect} />
                }
                <CardBody entry={liveEntry} echoedWhisper={echoedWhisper} getUserDisplayName={getUserDisplayName} />
                <CardAmplifiers amplifiers={Object.entries(liveEntry.amplifiers || {})} getUserDisplayName={getUserDisplayName} onUserSelect={onUserSelect} />
                <CardActions
                    entry={liveEntry}
                    onShowConstellation={() => setShowConstellationViewer(true)}
                    onAddStar={() => showConfirmation({ message: `This will cost 5 Echoes to add a Star. Proceed?`, onConfirm: () => setShowAddStarModal(true) })}
                    onAmplify={() => showConfirmation({ message: `Invest ${amplifyCost} Echoes to amplify this whisper? This will reveal the author.`, onConfirm: executeAmplify })}
                    isAmplifying={isAmplifying}
                    isAmplifiedByCurrentUser={liveEntry.amplifiers && liveEntry.amplifiers[userId]}
                    amplifyCost={amplifyCost}
                />
                <CardAiMenu
                    entry={liveEntry}
                    handlers={{
                        handleDelete: () => showConfirmation({ message: "Are you sure you want to permanently delete this whisper?", onConfirm: executeDelete }),
                        handleEcho: () => showConfirmation({ message: `Echoing a whisper costs 15 Echoes. Proceed?`, onConfirm: () => setShowEchoModal(true) }),
                        handleLikeToggle,
                        handleDislikeToggle,
                        runAiAction,
                        handleGetPublicSummary,
                        handleGetPublicSentiment,
                        handleReport,
                    }}
                    loadingAction={loadingAction}
                    isMoodInsightCoolingDown={isMoodInsightCoolingDown}
                    moodInsightTimeLeft={moodInsightTimeLeft}
                />

                <div className="mt-4 pt-4 border-t border-gray-700/50">
                    <button onClick={() => setShowComments(!showComments)} className="flex items-center text-sm font-semibold text-gray-300 hover:text-white">
                        <LucideIcons.MessageSquare size={16} className="mr-2" />
                        {showComments ? 'Hide' : 'Show'} Comments ({liveEntry.commentsCount || 0})
                        <LucideIcons.ChevronDown size={16} className={`ml-1 transition-transform ${showComments ? 'rotate-180' : ''}`} />
                    </button>
                </div>

                {showComments && <CommentSection entryId={liveEntry.id} currentUserId={userId} onUserSelect={onUserSelect} />}
            </div>
        </>
    );
}
function AnonymousFeed() {
    const { user, userId, userProfiles, db, getDoc, handleUserSelect, LucideIcons, appFunctions, setMessage, updateUserTokens, generateContentWithGemini, entryToScrollTo, setEntryToScrollTo, appId, arrayUnion, doc, updateDoc, onSnapshot } = useAppContext();
    const [displayedEntries, setDisplayedEntries] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState(null);
    const [aiModalContent, setAiModalContent] = useState(null);
    const [aiModalTitle, setAiModalTitle] = useState('');
    const [activeSuggestion, setActiveSuggestion] = useState(null);

    useEffect(() => {
        if (!userId) return;
        const suggestionRef = doc(db, `artifacts/${appId}/users/${userId}/suggestions/active-suggestion`);
        const unsubscribe = onSnapshot(suggestionRef, (doc) => {
            if (doc.exists()) {
                setActiveSuggestion(doc.data());
            } else {
                setActiveSuggestion(null);
            }
        });
        return () => unsubscribe();
    }, [userId, db, doc, onSnapshot, appId]);

    const getUserDisplayName = useCallback((authorId) => userProfiles.find(p => p.id === authorId)?.displayName || 'Anonymous User', [userProfiles]);

    const fetchFeed = useCallback(async (offset = 0) => {
        if (offset === 0) setIsLoading(true);
        else setIsLoadingMore(true);
        setError(null);

        const getPersonalizedFeed = httpsCallable(appFunctions, 'getPersonalizedFeed');
        try {
            // Fetch the spotlight whisper in parallel with the main feed
            const spotlightPromise = getDoc(doc(db, `artifacts/${appId}/public/data/app_metadata/current_spotlight`));
            const feedPromise = getPersonalizedFeed({ offset, limit: 10 });

            const [spotlightDoc, feedResult] = await Promise.all([spotlightPromise, feedPromise]);

            let newEntries = feedResult.data.feed || [];
            let spotlightWhisper = null;

            if (spotlightDoc.exists() && spotlightDoc.data().entryId) {
                const spotlightWhisperDoc = await getDoc(doc(db, `artifacts/${appId}/public/data/anonymous_entries`, spotlightDoc.data().entryId));
                if (spotlightWhisperDoc.exists()) {
                    spotlightWhisper = { id: spotlightWhisperDoc.id, ...spotlightWhisperDoc.data(), isSpotlight: true };
                    // Ensure the spotlight whisper isn't duplicated in the main feed
                    newEntries = newEntries.filter(w => w.id !== spotlightWhisper.id);
                }
            }

            if (offset === 0) {
                const finalFeed = spotlightWhisper ? [spotlightWhisper, ...newEntries] : newEntries;
                setDisplayedEntries(finalFeed);
            } else {
                setDisplayedEntries(prev => {
                    const existingIds = new Set(prev.map(p => p.id));
                    const filteredNew = newEntries.filter(n => !existingIds.has(n.id));
                    return [...prev, ...filteredNew];
                });
            }
            setHasMore(newEntries.length >= 10);
        } catch (err) {
            console.error("Error fetching personalized feed:", err);
            setError(`Failed to load your feed. Please try again later.`);
        } finally {
            setIsLoading(false);
            setIsLoadingMore(false);
        }
    }, [appFunctions, doc, getDoc, db, appId]);


    useEffect(() => {
        fetchFeed(0);
    }, [fetchFeed]);

useEffect(() => {
    if (entryToScrollTo && displayedEntries.length > 0) {
        const element = document.getElementById(`whisper-${entryToScrollTo}`);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // --- THIS IS THE FIX ---
            // Add a visual highlight to make the scrolled-to entry obvious.
            element.style.transition = 'background-color 0.5s ease-in-out, box-shadow 0.5s ease-in-out';
            element.style.backgroundColor = 'rgba(59, 130, 246, 0.3)';
            element.style.boxShadow = '0 0 20px rgba(59, 130, 246, 0.5)';
            setTimeout(() => {
                element.style.backgroundColor = '';
                element.style.boxShadow = '';
            }, 2500);
        }
        setEntryToScrollTo(null);
    }
}, [entryToScrollTo, displayedEntries, setEntryToScrollTo]);

    const handleLoadMore = () => {
        if (hasMore && !isLoadingMore) {
            fetchFeed(displayedEntries.length);
        }
    };
    // In App.js, inside the AnonymousFeed component, REPLACE the two reaction handler functions.

    // In App.js, inside the AnonymousFeed component, REPLACE the two reaction handler functions.

    const handleLikeToggle = useCallback(async (entryId, authorId) => {
        if (!user) { setMessage("Please sign in."); return; }

        // --- DEFINITIVE OPTIMISTIC UI UPDATE ---
        // Step 1: Immediately update the local state for an instant UI change.
        setDisplayedEntries(prevEntries => prevEntries.map(entry => {
            if (entry.id === entryId) {
                const alreadyLiked = entry.likes?.includes(userId);

                // If it's already liked, we are unliking it.
                if (alreadyLiked) {
                    return {
                        ...entry,
                        likes: entry.likes.filter(id => id !== userId),
                        likesCount: (entry.likesCount || 1) - 1,
                    };
                }

                // If it's not liked, we are liking it.
                const wasDisliked = entry.dislikes?.includes(userId);
                return {
                    ...entry,
                    likes: [...(entry.likes || []), userId],
                    dislikes: wasDisliked ? entry.dislikes.filter(id => id !== userId) : entry.dislikes,
                    likesCount: (entry.likesCount || 0) + 1,
                    dislikesCount: wasDisliked ? (entry.dislikesCount || 1) - 1 : (entry.dislikesCount || 0),
                };
            }
            return entry;
        }));

        // Step 2: Send the update to the server silently in the background.
        const toggleReaction = httpsCallable(appFunctions, 'togglePostReaction');
        try {
            await toggleReaction({ entryId, authorId, reactionType: 'like' });
        } catch (error) {
            console.error("Error syncing 'like' reaction:", error);
            setMessage("Like failed to sync. Reverting.");
            // Step 3: Rollback on failure. The safest way is to re-fetch the feed.
            fetchFeed(0);
        }
    }, [user, userId, appFunctions, setMessage, fetchFeed]);

    const handleDislikeToggle = useCallback(async (entryId, authorId) => {
        if (!user) { setMessage("Please sign in."); return; }

        // --- DEFINITIVE OPTIMISTIC UI UPDATE ---
        setDisplayedEntries(prevEntries => prevEntries.map(entry => {
            if (entry.id === entryId) {
                const alreadyDisliked = entry.dislikes?.includes(userId);

                // If it's already disliked, we are undisliking it.
                if (alreadyDisliked) {
                    return {
                        ...entry,
                        dislikes: entry.dislikes.filter(id => id !== userId),
                        dislikesCount: (entry.dislikesCount || 1) - 1,
                    };
                }

                // If it's not disliked, we are disliking it.
                const wasLiked = entry.likes?.includes(userId);
                return {
                    ...entry,
                    dislikes: [...(entry.dislikes || []), userId],
                    likes: wasLiked ? entry.likes.filter(id => id !== userId) : entry.likes,
                    dislikesCount: (entry.dislikesCount || 0) + 1,
                    likesCount: wasLiked ? (entry.likesCount || 1) - 1 : (entry.likesCount || 0),
                };
            }
            return entry;
        }));

        // Step 2: Send the update to the server silently in the background.
        const toggleReaction = httpsCallable(appFunctions, 'togglePostReaction');
        try {
            await toggleReaction({ entryId, authorId, reactionType: 'dislike' });
        } catch (error) {
            console.error("Error syncing 'dislike' reaction:", error);
            setMessage("Dislike failed to sync. Reverting.");
            // Step 3: Rollback on failure.
            fetchFeed(0);
        }
    }, [user, userId, appFunctions, setMessage, fetchFeed]);

    const handleRevealAuthor = useCallback(async (entry) => {
        if (!user) { setMessage("Please sign in to reveal author."); return; }
        if (entry.authorId === userId) { setMessage("You are the author of this Whisper."); return; }
        const userProfile = userProfiles.find(p => p.id === userId);
        if (!userProfile || userProfile.tokens < TOKEN_COSTS.REVEAL_AUTHOR) {
            setMessage(`Not enough Echoes to reveal author. You need ${TOKEN_COSTS.REVEAL_AUTHOR} Echoes.`);
            return;
        }
        if (entry.revealedBy?.includes(userId)) {
            setMessage("You have already revealed this author.");
            return;
        }

        try {
            await updateUserTokens(userId, -TOKEN_COSTS.REVEAL_AUTHOR);
            await updateUserTokens(entry.authorId, TOKEN_COSTS.REVEAL_AUTHOR * 0.5);
            await updateDoc(doc(db, `artifacts/${appId}/public/data/anonymous_entries`, entry.id), { revealedBy: arrayUnion(userId) });
            setMessage(`Author revealed! ${TOKEN_COSTS.REVEAL_AUTHOR} Echoes paid. Author earned ${TOKEN_COSTS.REVEAL_AUTHOR * 0.5} Echoes.`);
        } catch (e) {
            console.error("Error revealing author:", e);
            setMessage(`Failed to reveal author: ${e.message}`);
            await updateUserTokens(userId, TOKEN_COSTS.REVEAL_AUTHOR);
        }
    }, [user, userId, userProfiles, db, updateUserTokens, appId, doc, updateDoc, arrayUnion, setMessage]);

    const aiAnalysisHandler = async (analysisType, entryId, content, title) => {
        try {
            const getAnalysis = httpsCallable(appFunctions, 'getAiAnalysis');
            const result = await getAnalysis({ entryId, analysisType, content });
            setAiModalTitle(title);
            setAiModalContent(result.data.text);
        } catch (error) {
            console.error(`Error getting AI ${analysisType}: `, error);
            setMessage(error.message);
        }
    };

    const handleGetPublicSummary = (entryId, content) => aiAnalysisHandler('PUBLIC_SUMMARY', entryId, content, "Entry Summary");
    const handleGetPublicSentiment = (entryId, content) => aiAnalysisHandler('PUBLIC_SENTIMENT', entryId, content, "Entry Sentiment");
    const handleGetTeaser = (entryId, content) => aiAnalysisHandler('GET_TEASER', entryId, content, "AI Teaser");
    const handleGetSimilarEntries = (entryId, content) => aiAnalysisHandler('GET_SIMILAR_ENTRIES', entryId, content, "Similar Entries");

    const handleGetMoodInsightForEntry = useCallback(async (entryId, contentToAnalyze) => {
        try {
            const generatedText = await generateContentWithGemini(`Analyze the overall mood and dominant emotions in the following journal entry. Provide a concise summary(around 30 - 50 words) of the entry's emotional state. Entry: "${contentToAnalyze}"`);
            if (generatedText) {
                setAiModalTitle("Entry Mood Insight");
                setAiModalContent(generatedText);
            } else {
                setMessage('Failed to generate mood insight.');
            }
        } catch (e) {
            console.error(`Error calling Gemini API for mood insight:`, e);
            setMessage(`Error generating mood insight: ${e.message}`);
        }
    }, [generateContentWithGemini, setMessage]);

    if (isLoading) {
        return <LoadingSpinner message="Curating your personal feed..." />;
    }

    if (error) {
        return (
            <div className="text-center text-red-300 p-8 bg-red-900/30 rounded-lg">
                <LucideIcons.WifiOff size={48} className="mx-auto mb-4" />
                <h3 className="text-xl font-bold">Connection Error</h3>
                <p className="mt-2">{error}</p>
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-6 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-3xl mx-auto text-white">
            {aiModalContent && <AIGeneratedContentModal title={aiModalTitle} content={aiModalContent} onClose={() => setAiModalContent(null)} LucideIcons={LucideIcons} />}

            <h2 className="text-3xl font-bold text-center mb-6 text-blue-300 font-playfair">Public Whispers</h2>

            {activeSuggestion && <ProactiveSuggestionBanner suggestion={activeSuggestion} />}

            {displayedEntries.length === 0 && !isLoadingMore ? (
                <div className="text-center text-gray-300 p-8 bg-gray-800/50 rounded-lg">
                    <LucideIcons.Wind size={48} className="mx-auto mb-4 text-blue-400" />
                    <h3 className="text-xl font-bold">The Air is Quiet</h3>
                    <p className="mt-2">There are no new whispers in your cosmos right now. Why not be the first to share a thought?</p>
                </div>
            ) : (
                <div className="space-y-6">
                    {displayedEntries.map(e => (
                        <div key={e.id} id={`whisper-${e.id}`}>
                            <AnonymousEntryCard
                                entry={e}
                                userId={userId}
                                user={user}
                                getUserDisplayName={getUserDisplayName}
                                handleRevealAuthor={handleRevealAuthor}
                                handleGetTeaser={handleGetTeaser}
                                handleGetSimilarEntries={handleGetSimilarEntries}
                                handleLikeToggle={handleLikeToggle}
                                handleDislikeToggle={handleDislikeToggle}
                                handleGetPublicSummary={handleGetPublicSummary}
                                handleGetPublicSentiment={handleGetPublicSentiment}
                                handleGetMoodInsightForEntry={handleGetMoodInsightForEntry}
                                onUserSelect={handleUserSelect}
                            />
                        </div>
                    ))}
                </div>
            )}
            {hasMore && (
                <button onClick={handleLoadMore} disabled={isLoadingMore} className="w-full px-6 py-3 bg-blue-600 text-white font-bold rounded-full hover:bg-blue-700 transition duration-300 transform hover:scale-105 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center mt-6">
                    {isLoadingMore ? (<div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white"></div>) : ('Load More Whispers')}
                </button>
            )}
            {!hasMore && displayedEntries.length > 0 && (
                <p className="text-center text-gray-400 mt-6">You've reached the end of your personalized feed for now.</p>
            )}
        </div>
    );
}



// In App.js, REPLACE the existing Comment component with this single, complete version.

const Comment = ({ comment, onReply, onAiReply, onTranslate, onReact, onMentionClick, level, onUserSelect }) => {
    const { userProfiles, db, collection, query, where, orderBy, onSnapshot, doc, appId, userId, setMessage, LucideIcons, appFunctions, showConfirmation, currentUserProfile } = useAppContext();
    const [replies, setReplies] = useState([]);
    const [showReplies, setShowReplies] = useState(true); // Replies are shown by default
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const menuRef = useRef(null);
    const [isReactMenuOpen, setIsReactMenuOpen] = useState(false);
    const [loadingAction, setLoadingAction] = useState(null);

    const authorProfile = userProfiles.find(p => p.id === comment.authorId);
    const defaultAvatar = "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U";
    const isAnonymous = comment.isAnonymous || !authorProfile;
    const isAmplifiedByCurrentUser = comment.amplifiers && comment.amplifiers[userId];
    const isPro = authorProfile?.proStatus === 'active';

    const { textWithoutUrl, mediaUrl: extractedMediaUrl } = extractMediaUrl(comment.content);
    const finalMediaUrl = comment.mediaUrl || extractedMediaUrl;
    const finalContent = comment.mediaUrl ? comment.content : textWithoutUrl;

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
                setIsMenuOpen(false);
                setIsReactMenuOpen(false);
            }
        };
        if (isMenuOpen || isReactMenuOpen) document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isMenuOpen, isReactMenuOpen]);

    useEffect(() => {
        if (!comment.id) return;
        const repliesQuery = query(
            collection(db, `artifacts/${appId}/public/data/anonymous_entries/${comment.entryId}/comments`),
            where("parentId", "==", comment.id),
            orderBy("timestamp", "asc")
        );
        const unsubscribe = onSnapshot(repliesQuery, (snapshot) => {
            setReplies(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        });
        return () => unsubscribe();
    }, [db, comment.entryId, collection, onSnapshot, orderBy, query, where, comment.id, appId]);

    const runAiCommentAction = async (action, handler) => {
        setLoadingAction(action);
        setIsMenuOpen(false);
        await handler();
        setLoadingAction(null);
    };

    const executeAmplifyComment = useCallback(async () => {
        setLoadingAction('amplify');
        const amplifyComment = httpsCallable(appFunctions, 'amplifyComment');
        try {
            await amplifyComment({ entryId: comment.entryId, commentId: comment.id });
            setMessage("Comment amplified!");
        } catch (error) {
            setMessage(`Amplification failed: ${error.message}`);
        } finally {
            setLoadingAction(null);
        }
    }, [appFunctions, comment.entryId, comment.id, setMessage]);

    const executeDelete = useCallback(async () => {
        setLoadingAction('delete');
        const deleteComment = httpsCallable(appFunctions, 'deleteComment');
        try {
            await deleteComment({ entryId: comment.entryId, commentId: comment.id });
            // No success message needed, as the comment will disappear.
        } catch (error) {
            setMessage(`Failed to delete comment: ${error.message}`);
        } finally {
            setLoadingAction(null);
            setIsMenuOpen(false);
        }
    }, [appFunctions, comment.entryId, comment.id, setMessage]);

    const handleReport = () => {
        setIsMenuOpen(false);
        const reason = prompt("Please provide a brief reason for reporting this comment (e.g., spam, harassment).");
        if (reason && reason.trim()) {
            const reportContent = httpsCallable(appFunctions, 'reportContent');
            reportContent({ contentId: comment.id, contentType: 'comment', reason: reason.trim() })
                .then((result) => setMessage(result.data.message))
                .catch(err => setMessage(`Report failed: ${err.message}`));
        } else if (reason !== null) {
            setMessage("A reason is required to submit a report.");
        }
    };

    const handleDelete = () => {
        showConfirmation({
            message: "Are you sure you want to permanently delete this comment?",
            onConfirm: executeDelete
        });
    };

    const handleAmplify = () => {
        showConfirmation({
            message: "Amplify this comment for 10 Echoes?",
            onConfirm: executeAmplifyComment
        });
    };

    const renderContent = (text) => {
        if (!text) return null;
        const parts = text.split(/(@[a-zA-Z0-9_]+)/g);
        return parts.map((part, index) => {
            if (part.startsWith('@')) {
                const username = part.substring(1);
                return <strong key={index} className="text-blue-400 cursor-pointer hover:underline" onClick={() => onMentionClick(username)}>{part}</strong>;
            }
            return part;
        });
    };

    const reactions = comment.reactions || {};

    const handleReactAndClose = (commentId, emoji) => {
        onReact(commentId, emoji);
        setIsReactMenuOpen(false);
        setIsMenuOpen(false);
    };

    return (
        <div className={`relative pt-4 ${level > 0 ? "ml-4 md:ml-6" : ""}`}>
            {level > 0 && <div className="absolute top-0 left-5 w-0.5 h-full bg-gray-700/50"></div>}

            <div className="relative flex items-start space-x-3">
                {level > 0 && <div className="absolute top-7 left-[-4px] w-4 h-0.5 bg-gray-700/50"></div>}
                <img src={isAnonymous ? defaultAvatar : authorProfile?.photoURL || defaultAvatar} alt={isAnonymous ? 'Anonymous' : authorProfile?.displayName} className={`w-10 h-10 rounded-full object-cover flex-shrink-0 z-10 ${!isAnonymous && 'cursor-pointer'}`} onClick={() => !isAnonymous && onUserSelect(comment.authorId)} />

                <div className={`flex-1 bg-gray-800/50 p-3 rounded-lg border ${isPro ? 'pro-comment' : comment.echoesInvested > 0 ? 'border-yellow-400/80' : 'border-gray-700/80'}`}>
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                            <p className={`font-bold text-blue-300 text-sm ${!isAnonymous && 'cursor-pointer hover:underline'}`} onClick={() => !isAnonymous && onUserSelect(comment.authorId)}>{isAnonymous ? 'Anonymous' : authorProfile?.displayName}</p>
                            {isPro && <LucideIcons.Crown size={14} className="text-amber-300" />}
                        </div>
                        <p className="text-xs text-gray-400">{comment.timestamp?.toDate().toLocaleString()}</p>
                    </div>
                    <div className="text-gray-100 mt-1 text-md break-words">{renderContent(finalContent)}</div>
                    <UniversalMediaRenderer entry={comment} />

                    <div className="flex items-center justify-between mt-3">
                        <div className="flex items-center space-x-2 flex-wrap gap-y-2">
                            {Object.entries(reactions).map(([emoji, userIds]) => userIds.length > 0 && (
                                <div key={emoji} className="flex items-center px-2 py-1 bg-gray-700/60 rounded-full text-xs">
                                    <span>{emoji}</span>
                                    <span className="ml-1.5 font-semibold text-gray-300">{userIds.length}</span>
                                </div>
                            ))}
                            {comment.echoesInvested > 0 && (
                                <div className="flex items-center px-2 py-1 bg-yellow-900/60 rounded-full text-xs text-yellow-300 font-semibold">
                                    <LucideIcons.Flame size={12} className="mr-1.5" />
                                    {comment.echoesInvested}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center space-x-4 mt-2 text-xs">
                        <button onClick={() => onReply(comment)} className="font-semibold text-gray-300 hover:text-white">Reply</button>
                        {replies.length > 0 && <button onClick={() => setShowReplies(!showReplies)} className="font-semibold text-gray-400 hover:text-white">{showReplies ? 'Hide' : 'Show'} {replies.length} {replies.length > 1 ? 'replies' : 'reply'}</button>}
                        <HoverTooltip text={`Invest 10 Echoes to boost this comment's visibility and reward the author.`}>
                            <button onClick={handleAmplify} disabled={loadingAction === 'amplify' || userId === comment.authorId} className={`font-semibold ${isAmplifiedByCurrentUser ? 'text-green-400' : 'text-yellow-400 hover:text-yellow-300'} disabled:opacity-50`}>
                                {loadingAction === 'amplify' ? 'Amplifying...' : 'Amplify'}
                            </button>
                        </HoverTooltip>

                        <div className="relative ml-auto" ref={menuRef}>
                            <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="p-1 -m-1"><LucideIcons.MoreHorizontal size={16} className="cursor-pointer text-gray-400 hover:text-white" /></button>
                            <div className={`absolute bottom-full mb-2 right-0 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-lg transition-all duration-200 z-[100] ${isMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
                                <button onClick={() => runAiCommentAction('suggest', () => onAiReply(comment.content))} disabled={loadingAction} className="flex items-center w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"><LucideIcons.Sparkles size={14} className="mr-2 text-purple-400" /> Suggest Reply</button>
                                <button onClick={() => runAiCommentAction('translate', () => onTranslate(comment.content))} disabled={loadingAction} className="flex items-center w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"><LucideIcons.Languages size={14} className="mr-2 text-sky-400" /> Translate</button>
                                <div className="relative">
                                    <button onClick={() => setIsReactMenuOpen(!isReactMenuOpen)} className="flex items-center w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"><LucideIcons.Heart size={14} className="mr-2 text-pink-400" /> React</button>
                                    <div className={`absolute bottom-0 right-full mr-2 flex space-x-1 p-2 bg-gray-900 border border-gray-700 rounded-lg transition-all duration-200 ${isReactMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
                                        <button onClick={() => handleReactAndClose(comment.id, '❤️')} className="p-1 hover:scale-125 transition-transform">❤️</button>
                                        <button onClick={() => handleReactAndClose(comment.id, '😂')} className="p-1 hover:scale-125 transition-transform">😂</button>
                                        <button onClick={() => handleReactAndClose(comment.id, '🤔')} className="p-1 hover:scale-125 transition-transform">🤔</button>
                                        <button onClick={() => handleReactAndClose(comment.id, '🔥')} className="p-1 hover:scale-125 transition-transform">🔥</button>
                                        <button onClick={() => handleReactAndClose(comment.id, '✨')} className="p-1 hover:scale-125 transition-transform" title="Super Reaction">✨</button>
                                    </div>
                                </div>
                                <div className="my-1 border-t border-gray-700"></div>
                                <button onClick={handleReport} className="flex items-center w-full text-left px-3 py-2 text-sm text-orange-400 hover:bg-gray-800 font-bold"><LucideIcons.Flag size={14} className="mr-2" /> Report</button>
                                {(userId === comment.authorId || currentUserProfile?.role === 'moderator' || currentUserProfile?.role === 'admin' || currentUserProfile?.role === 'owner') && (
                                    <>
                                        <div className="my-1 border-t border-gray-700"></div>
                                        <button onClick={handleDelete} disabled={loadingAction === 'delete'} className="flex items-center w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800 font-bold disabled:opacity-50">
                                            {loadingAction === 'delete' ? <div className="action-spinner"></div> : <LucideIcons.Trash2 size={14} className="mr-2" />} Delete Comment
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {showReplies && replies.length > 0 && (
                <div className="mt-2">
                    {replies.map(reply => (
                        <Comment key={reply.id} comment={reply} onReply={onReply} onAiReply={onAiReply} onTranslate={onTranslate} onReact={onReact} onMentionClick={onMentionClick} level={level + 1} onUserSelect={onUserSelect} />
                    ))}
                </div>
            )}
        </div>
    );
};
// In App.js, REPLACE the entire CommentSection component with this one.

// In App.js, REPLACE the entire CommentSection component with this one.
function CommentSection({ entryId, currentUserId, onUserSelect }) {
    const { db, uploadFile, LucideIcons, appFunctions, setMessage, collection, updateUserTokens, query, handlePageChange, orderBy, onSnapshot, doc, getDoc, showConfirmation, userProfiles, appId } = useAppContext();
    const [newComment, setNewComment] = useState('');
    const [newCommentMedia, setNewCommentMedia] = useState(null);
    const [mediaPreview, setMediaPreview] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [replyingTo, setReplyingTo] = useState(null);
    const [isAnonymousComment, setIsAnonymousComment] = useState(false);
    const commentMediaInputRef = useRef(null);
    const [aiModalContent, setAiModalContent] = useState(null);
    const [aiModalTitle, setAiModalTitle] = useState('');
    const [commentsCount, setCommentsCount] = useState(0);

    const commentsQuery = useMemo(() =>
        query(collection(db, `artifacts/${appId}/public/data/anonymous_entries/${entryId}/comments`), orderBy("timestamp", "asc")),
        [db, appId, entryId]
    );
    const { data: allComments, isLoading, error } = useFirestoreQuery(commentsQuery);

    useEffect(() => {
        const whisperRef = doc(db, `artifacts/${appId}/public/data/anonymous_entries`, entryId);
        const unsubscribe = onSnapshot(whisperRef, (docSnap) => {
            setCommentsCount(docSnap.data()?.commentsCount || 0);
        });
        return () => unsubscribe();
    }, [db, appId, entryId]);

    const comments = useMemo(() => {
        const commentMap = {};
        const topLevelComments = [];
        allComments.forEach(c => { commentMap[c.id] = { ...c, replies: [] }; });
        allComments.forEach(c => {
            if (c.parentId && commentMap[c.parentId]) {
                commentMap[c.parentId].replies.push(commentMap[c.id]);
            } else {
                topLevelComments.push(commentMap[c.id]);
            }
        });
        return topLevelComments;
    }, [allComments]);

    const handleCommentMediaSelect = (e) => {
        const file = e.target.files[0];
        if (file) {
            setNewCommentMedia(file);
            setMediaPreview(URL.createObjectURL(file));
        }
    };

    const handleAddComment = useCallback(async () => {
        if (!newComment.trim() && !newCommentMedia) {
            setMessage('Comment cannot be empty.');
            return;
        }
        setIsSubmitting(true);
        try {
            let mediaUrl = '';
            if (newCommentMedia) {
                const filePath = `comments/${currentUserId}/${Date.now()}_${newCommentMedia.name}`;
                mediaUrl = await uploadFile(newCommentMedia, filePath, () => { });
            }

            const createComment = httpsCallable(appFunctions, 'createComment');
            await createComment({
                entryId: entryId,
                content: newComment.trim(),
                parentId: replyingTo ? replyingTo.id : null,
                mediaUrl: mediaUrl,
                isAnonymous: isAnonymousComment,
            });

            setNewComment('');
            setNewCommentMedia(null);
            setMediaPreview('');
            setReplyingTo(null);
            if (commentMediaInputRef.current) commentMediaInputRef.current.value = "";
        } catch (e) {
            console.error("Error adding comment:", e);
            setMessage(`Failed to add comment: ${e.message}`);
        } finally {
            setIsSubmitting(false);
        }
    }, [newComment, newCommentMedia, replyingTo, currentUserId, entryId, isAnonymousComment, appFunctions, uploadFile, setMessage]);

    const handleReaction = useCallback(async (commentId, emoji) => {
        if (!currentUserId) {
            setMessage("Please sign in to react.");
            return;
        }
        const updateCommentReaction = httpsCallable(appFunctions, 'updateCommentReaction');
        try {
            await updateCommentReaction({ entryId, commentId, emoji });
        } catch (error) {
            console.error("Error reacting to comment:", error);
            setMessage(`Reaction failed: ${error.message}`);
        }
    }, [currentUserId, entryId, appFunctions, setMessage]);

    const callCommentAI = async (analysisType, content, title) => {
        setMessage(`Generating ${title}...`);
        try {
            const getAnalysis = httpsCallable(appFunctions, 'getAiAnalysis');
            const result = await getAnalysis({ analysisType, content });
            setAiModalTitle(title);
            setAiModalContent(result.data.text);
            setMessage(`${title} generated! ${result.data.cost} Echoes spent.`);
        } catch (error) {
            console.error(`Error getting AI ${analysisType}: `, error);
            setMessage(error.message);
        }
    };

    const handleAiReply = (commentContent) => {
        showConfirmation({
            message: `Generate an AI reply suggestion? This will cost a small fee.`,
            onConfirm: () => callCommentAI('SUGGEST_COMMENT_REPLY', commentContent, "AI Reply Suggestion")
        });
    };

    const handleTranslate = (commentContent) => {
        showConfirmation({
            message: `Translate this comment with AI? This will cost a small fee.`,
            onConfirm: () => callCommentAI('TRANSLATE_COMMENT', commentContent, "Translation")
        });
    };

    const executeVibeCheck = useCallback(async () => {
        const currentUser = userProfiles.find(p => p.id === currentUserId);
        if (!currentUser || currentUser.tokens < TOKEN_COSTS.VIBE_CHECK) {
            setMessage(`Not enough Echoes. You need ${TOKEN_COSTS.VIBE_CHECK} Echoes.`);
            return;
        }

        setMessage("Checking the vibe...");
        try {
            await updateUserTokens(currentUserId, -TOKEN_COSTS.VIBE_CHECK);
            const vibeCheck = httpsCallable(appFunctions, 'getCommentVibe');
            const result = await vibeCheck({ entryId });
            setAiModalTitle("Conversation Vibe Check");
            setAiModalContent(result.data.vibe);
        } catch (e) {
            setMessage("Could not check the vibe at this time. Your Echoes have been refunded.");
            await updateUserTokens(currentUserId, TOKEN_COSTS.VIBE_CHECK);
        }
    }, [appFunctions, entryId, currentUserId, userProfiles, updateUserTokens, setMessage]);

    const handleVibeCheck = () => {
        showConfirmation({
            message: `This will cost ${TOKEN_COSTS.VIBE_CHECK} Echoes. Proceed with Vibe Check?`,
            onConfirm: executeVibeCheck
        });
    };

    const handleMentionClick = (username) => {
        const mentionedUser = userProfiles.find(p => p.displayName === username);
        if (mentionedUser) {
            handlePageChange('viewingProfile', { userId: mentionedUser.id });
        } else {
            setMessage(`User @${username} not found.`);
        }
    };

    return (
        <div className="mt-6 pt-6 border-t border-gray-700/50">
            {aiModalContent && <AIGeneratedContentModal title={aiModalTitle} content={aiModalContent} onClose={() => setAiModalContent(null)} LucideIcons={LucideIcons} />}
            <div className="flex justify-between items-center mb-4">
                <h4 className="text-xl font-semibold text-gray-100 font-playfair">Conversation ({commentsCount})</h4>
                <button onClick={handleVibeCheck} className="flex items-center text-sm text-purple-300 hover:text-purple-200">
                    <LucideIcons.Sparkles size={16} className="mr-2" /> Vibe Check
                </button>
            </div>

            {currentUserId && (
                // --- THIS IS THE FIX ---
                // The classes on this div have been updated to create a themed, glowing input box.
                <div className="bg-gray-800/50 p-3 rounded-lg mb-6 border border-gray-700/80 transition-all duration-300 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/50">
                    {replyingTo && (<div className="text-xs text-gray-400 mb-2 p-2 bg-gray-900/50 rounded-md">Replying to {userProfiles.find(p => p.id === replyingTo.authorId)?.displayName || 'Anonymous User'}<button onClick={() => setReplyingTo(null)} className="ml-2 font-bold text-red-400">[Cancel]</button></div>)}
                    <textarea value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Share your thoughts..." className="w-full bg-transparent text-white focus:outline-none resize-none" rows={2} />
                    {mediaPreview && (
                        <div className="my-2 relative w-24">
                            <UniversalMediaRenderer url={mediaPreview} />
                            <button onClick={() => { setNewCommentMedia(null); setMediaPreview(''); }} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5 hover:bg-red-600"><LucideIcons.X size={12} /></button>
                        </div>
                    )}
                    <div className="flex justify-between items-center mt-2">
                        <div className="flex items-center space-x-4">
                            <input type="file" ref={commentMediaInputRef} onChange={handleCommentMediaSelect} className="hidden" accept="image/*,video/*" />
                            <button type="button" onClick={() => commentMediaInputRef.current.click()} className="text-gray-400 hover:text-white" title="Attach Media"><LucideIcons.ImagePlus size={20} /></button>
                            <div className="flex items-center" title="Post Anonymously">
                                <input type="checkbox" id="anonymousComment" checked={isAnonymousComment} onChange={(e) => setIsAnonymousComment(e.target.checked)} className="h-4 w-4 text-blue-500 bg-gray-700 border-gray-600 rounded focus:ring-blue-600" />
                                <label htmlFor="anonymousComment" className="ml-2 text-xs text-gray-400">Anonymous</label>
                            </div>
                        </div>
                        <button onClick={handleAddComment} disabled={isSubmitting} className="px-4 py-1.5 bg-blue-500 text-white text-sm font-semibold rounded-full hover:bg-blue-600 transition duration-300 disabled:opacity-50">
                            {isSubmitting ? 'Posting...' : (replyingTo ? 'Post Reply' : 'Post Comment')}
                        </button>
                    </div>
                </div>
            )}

            {isLoading ? <p className="text-gray-400">Loading comments...</p> : comments.length === 0 ? (
                <p className="text-sm text-gray-400 italic">No comments yet. Be the first!</p>
            ) : (
                <div className="space-y-4">
                    {comments.map(comment => (
                        <Comment
                            key={comment.id}
                            comment={comment}
                            onReply={setReplyingTo}
                            onAiReply={handleAiReply}
                            onTranslate={handleTranslate}
                            onReact={handleReaction}
                            onMentionClick={handleMentionClick}
                            level={0}
                            onUserSelect={onUserSelect}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}



const PayoutSetupModal = ({ onClose, LucideIcons }) => {
    const { user, userId, setMessage, appFunctions } = useAppContext();
    const handleStripeConnectOnboarding = useCallback(async () => {
        if (!user || !userId || !appFunctions) {
            setMessage("Please sign in to set up payouts.");
            return;
        }
        try {
            const createAccountLink = httpsCallable(appFunctions, 'createStripeConnectAccountLink');
            const result = await createAccountLink({
                returnUrl: window.location.origin + '?page=walletHub',
                refreshUrl: window.location.origin + '?page=walletHub',
            });
            const { url, error } = result.data;
            if (url) {
                window.location.href = url;
            } else {
                setMessage(`Failed to initiate Stripe Connect: ${error || 'Unknown error'}`);
            }
        } catch (e) {
            console.error("Error calling createStripeConnectAccountLink:", e);
            setMessage(`Error setting up Stripe Connect: ${e.message}`);
        }
    }, [user, userId, setMessage, appFunctions]);

    return (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex justify-center items-center z-50 p-4">
            <div className="bg-gray-800 bg-opacity-90 p-6 rounded-lg shadow-xl max-w-md w-full text-white relative">
                <h3 className="text-xl font-bold mb-4 text-blue-300 font-playfair">Setup Payouts</h3>
                <p className="text-lg mb-6 leading-relaxed">To receive your earnings, you need to set up a secure payout method through Stripe.</p>
                <div className="flex justify-center space-x-4">
                    <button onClick={handleStripeConnectOnboarding} className="px-6 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition duration-300">Connect with Stripe</button>
                    <button onClick={onClose} className="px-6 py-2 bg-gray-600 text-white rounded-md hover:bg-gray-700 transition duration-300">Not Now</button>
                </div>
                <button onClick={onClose} className="absolute top-3 right-3 p-2 rounded-full bg-gray-700 hover:bg-gray-600 text-white transition duration-300" aria-label="Close"><LucideIcons.X size={20} /></button>
            </div>
        </div>
    );
};


const ConnectionCard = ({ profile, strength, onSelect }) => {
    const { LucideIcons, onlineStatus } = useAppContext();
    const isOnline = onlineStatus[profile.id]?.state === 'online';

    const strengthColor = strength > 75 ? 'border-sky-400' : strength > 40 ? 'border-purple-400' : 'border-gray-600';

    return (
        <div onClick={onSelect} className={`connection-card ${strengthColor}`}>
            <div className="relative">
                <img src={profile.photoURL || "https://placehold.co/100x100/AEC6CF/FFFFFF?text=U"} alt={profile.displayName} className="w-20 h-20 rounded-full object-cover" />
                {isOnline && <span className="absolute bottom-0 right-0 w-4 h-4 bg-green-400 rounded-full border-2 border-gray-900" title="Online"></span>}
            </div>
            <p className="font-bold text-white truncate mt-2 text-sm">{profile.displayName}</p>
            <div className="w-full bg-gray-700 rounded-full h-1.5 mt-1">
                <div className="bg-gradient-to-r from-purple-500 to-sky-500 h-1.5 rounded-full" style={{ width: `${strength || 0}%` }}></div>
            </div>
        </div>
    );
};

function ConnectionHub() {
    const { userConnections, userProfiles, handleUserSelect } = useAppContext();
    const [isLoading, setIsLoading] = useState(true);
    const [connectionsWithProfiles, setConnectionsWithProfiles] = useState([]);

    useEffect(() => {
        if (userProfiles.length > 0) {
            const enrichedConnections = userConnections
                .map(conn => {
                    const profile = userProfiles.find(p => p.id === conn.followingId);
                    return profile ? { ...conn, profile } : null;
                })
                .filter(Boolean) // Remove any connections where the profile wasn't found
                .sort((a, b) => (b.strength || 0) - (a.strength || 0)); // Sort by strength

            setConnectionsWithProfiles(enrichedConnections);
            setIsLoading(false);
        }
    }, [userConnections, userProfiles]);

    if (isLoading) {
        return <LoadingSpinner message="Weaving your constellation..." />;
    }

    if (connectionsWithProfiles.length === 0) {
        return (
            <div className="text-center text-gray-300 p-8 bg-gray-800/50 rounded-lg">
                <LucideIcons.Users size={48} className="mx-auto mb-4 text-purple-400" />
                <h3 className="text-xl font-bold">Your Cosmos is Quiet</h3>
                <p className="mt-2">Connect with other users to build your personal constellation.</p>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-fadeIn">
            <div>
                <h2 className="text-2xl font-bold text-blue-200 font-playfair mb-4">Connection Matrix</h2>
                <div className="flex overflow-x-auto custom-scrollbar pb-4 gap-4">
                    {connectionsWithProfiles.map(conn => (
                        <ConnectionCard
                            key={conn.id}
                            profile={conn.profile}
                            strength={conn.strength}
                            onSelect={() => handleUserSelect(conn.profile.id)}
                        />
                    ))}
                </div>
            </div>

            <div>
                <h2 className="text-2xl font-bold text-blue-200 font-playfair mb-4">The Constellation</h2>
                <ConstellationView />
            </div>
        </div>
    );
}

function QuestBoard() {
    const { userProfiles, userId, LucideIcons, appFunctions, setMessage } = useAppContext();
    const [categorizedQuests, setCategorizedQuests] = useState({ daily: [], weekly: [], monthly: [], onboarding: [], milestones: [] });
    const [isLoading, setIsLoading] = useState(true);
    const [claimingId, setClaimingId] = useState(null);

    const currentUserProfile = userProfiles.find(p => p.id === userId);

    const allQuests = useMemo(() => [
        // Onboarding
        { id: 'post_first_whisper', title: 'Share Your First Whisper', description: 'Post your first anonymous thought to the feed.', reward: 25, type: 'onboarding', canClaim: (p) => true },
        { id: 'customize_profile', title: 'Personalize Your Space', description: 'Add a bio or some interests to your public profile.', reward: 20, type: 'onboarding', canClaim: (p) => p && ((p.bio && p.bio.length > 0) || (p.interests && p.interests.length > 0)) },
        { id: 'like_three_whispers', title: 'Curate the Feed', description: 'Like at least 3 whispers to show your appreciation.', reward: 10, type: 'onboarding', canClaim: (p) => p && (p.likesGiven || 0) >= 3 },
        { id: 'follow_a_user', title: 'Make a Connection', description: 'Follow another user.', reward: 10, type: 'onboarding', canClaim: (p) => p && (p.followingCount || 0) >= 1 },
        { id: 'join_a_nexus', title: 'Community Found', description: 'Become a member of any Nexus.', reward: 15, type: 'onboarding', canClaim: (p) => true },
        { id: 'seal_first_whisper', title: 'The First Secret', description: 'Post your first Sealed Whisper.', reward: 25, type: 'onboarding', canClaim: (p) => true },
        { id: 'echo_first_whisper', title: 'Resounding Thoughts', description: 'Echo another user\'s whisper for the first time.', reward: 20, type: 'onboarding', canClaim: (p) => true },

        // Daily
        { id: 'daily_login', title: 'Daily Presence', description: 'Log in and claim your daily bonus.', reward: 10, type: 'daily', canClaim: (p) => true },
        { id: 'amplify_whisper_daily', title: 'Daily Amplification', description: 'Amplify any whisper to boost its reach.', reward: 15, type: 'daily', canClaim: (p) => p && (p.dailyQuestProgress?.amplifies || 0) >= 1 },
        { id: 'add_star_daily', title: 'Daily Constellation Growth', description: 'Add a Star to any existing Constellation.', reward: 10, type: 'daily', canClaim: (p) => p && (p.dailyQuestProgress?.starsAdded || 0) >= 1 },
        { id: 'post_whisper_daily', title: 'Daily Thought', description: 'Share a whisper with the world.', reward: 5, type: 'daily', canClaim: (p) => p && (p.dailyQuestProgress?.posts || 0) >= 1 },
        { id: 'send_three_messages_daily', title: 'Social Butterfly', description: 'Send 3 private messages.', reward: 10, type: 'daily', canClaim: (p) => p && (p.dailyQuestProgress?.messagesSent || 0) >= 3 },
        { id: 'open_echo_chamber_daily', title: 'Forge an Echo', description: 'Open your daily Echo Chamber.', reward: 5, type: 'daily', canClaim: (p) => p && (p.dailyQuestProgress?.echoChambersOpened || 0) >= 1 },
        { id: 'react_to_five_comments_daily', title: 'Vibe Curator', description: 'React to 5 different comments.', reward: 10, type: 'daily', canClaim: (p) => p && (p.dailyQuestProgress?.reactions || 0) >= 5 },
        { id: 'generate_ai_prompt_daily', title: 'AI Muse', description: 'Generate a prompt with the Whisper Forge AI.', reward: 5, type: 'daily', canClaim: (p) => p && (p.dailyQuestProgress?.promptsGenerated || 0) >= 1 },

        // Weekly
        { id: 'post_three_whispers_weekly', title: 'Weekly Contributor', description: 'Post at least 3 whispers this week.', reward: 30, type: 'weekly', canClaim: (p) => p && (p.weeklyQuestProgress?.posts || 0) >= 3 },
        { id: 'receive_five_amplifications_weekly', title: 'Influential Voice', description: 'Receive 5 amplifications on your whispers this week.', reward: 40, type: 'weekly', canClaim: (p) => p && (p.weeklyQuestProgress?.amplificationsReceived || 0) >= 5 },
        { id: 'connect_with_three_users_weekly', title: 'Networker', description: 'Connect with 3 new users.', reward: 25, type: 'weekly', canClaim: (p) => p && (p.weeklyQuestProgress?.connectionsMade || 0) >= 3 },
        { id: 'spend_100_echoes_weekly', title: 'Echo Spender', description: 'Spend 100 Echoes on features.', reward: 30, type: 'weekly', canClaim: (p) => p && (p.weeklyQuestProgress?.echoesSpent || 0) >= 100 },
        { id: 'earn_50_reputation_weekly', title: 'Rising Star', description: 'Gain 50 reputation points this week.', reward: 40, type: 'weekly', canClaim: (p) => p && ((p.reputationScore - (p.weeklyQuestProgress?.startReputation || p.reputationScore)) >= 50) },
        { id: 'start_constellation_weekly', title: 'Stargazer', description: 'Start a new Constellation this week.', reward: 20, type: 'weekly', canClaim: (p) => p && (p.weeklyQuestProgress?.constellationsStarted || 0) >= 1 },
        { id: 'get_harmony_sync_weekly', title: 'In Sync', description: 'Achieve a Harmony Sync in a private chat.', reward: 25, type: 'weekly', canClaim: (p) => p && (p.weeklyQuestProgress?.harmonySyncs || 0) >= 1 },

        // Monthly
        { id: 'maintain_positive_vibe_monthly', title: 'Positive Influence', description: 'Maintain a Vibe Score above 50.', reward: 75, type: 'monthly', canClaim: (p) => p && (p.vibeScore || 0) > 50 },
        { id: 'post_20_whispers_monthly', title: 'Dedicated Scribe', description: 'Post 20 whispers in a month.', reward: 100, type: 'monthly', canClaim: (p) => p && (p.monthlyQuestProgress?.posts || 0) >= 20 },
        { id: 'amplify_10_whispers_monthly', title: 'Patron of the Arts', description: 'Amplify 10 different whispers.', reward: 80, type: 'monthly', canClaim: (p) => p && (p.monthlyQuestProgress?.amplifies || 0) >= 10 },

        // Milestones
        { id: 'reach_100_reputation', title: 'Respected Voice', description: 'Achieve a Reputation Score of 100.', reward: 50, type: 'milestone', canClaim: (p) => p && (p.reputationScore || 0) >= 100 },
        { id: 'reach_500_reputation', title: 'Community Pillar', description: 'Achieve a Reputation Score of 500.', reward: 100, type: 'milestone', canClaim: (p) => p && (p.reputationScore || 0) >= 500 },
        { id: 'reach_1000_reputation', title: 'Nexus Elder', description: 'Achieve a Reputation Score of 1000.', reward: 250, type: 'milestone', canClaim: (p) => p && (p.reputationScore || 0) >= 1000 },
    ], []);

    // --- THIS IS THE FIX ---
    // This hook now correctly maps each quest to its corresponding category key in the state object.
    // The previous logic had a typo that prevented most quests from being categorized.
    useEffect(() => {
        if (currentUserProfile) {
            const categorized = { daily: [], weekly: [], monthly: [], onboarding: [], milestones: [] };
            allQuests.forEach(q => {
                const typeKey = q.type === 'milestone' ? 'milestones' : q.type;
                if (categorized[typeKey]) {
                    categorized[typeKey].push(q);
                }
            });
            setCategorizedQuests(categorized);
            setIsLoading(false);
        }
    }, [currentUserProfile, allQuests]);

    const handleClaimReward = async (questId) => {
        setClaimingId(questId);
        const claimQuestReward = httpsCallable(appFunctions, 'claimQuestReward');
        try {
            const result = await claimQuestReward({ questId });
            setMessage(`Quest complete! You earned ${result.data.reward} Echoes!`);
        } catch (error) {
            setMessage(`Failed to claim reward: ${error.message}`);
        } finally {
            setClaimingId(null);
        }
    };

    if (isLoading || !currentUserProfile) {
        return <LoadingSpinner message="Loading Quests..." />;
    }

    const QuestCard = ({ quest }) => {
        const [timeLeft, setTimeLeft] = useState('');
        const completionTimestamp = currentUserProfile.completedQuests?.[quest.id];

        const isPermanentlyCompleted = (quest.type === 'onboarding' || quest.type === 'milestone') && !!completionTimestamp;

        useEffect(() => {
            if (!completionTimestamp || isPermanentlyCompleted) return;

            const getCooldown = () => {
                if (quest.type === 'daily') return 22 * 3600 * 1000; // 22 hours
                if (quest.type === 'weekly') return 6.5 * 24 * 3600 * 1000; // 6.5 days
                return 0;
            };

            const cooldown = getCooldown();
            if (cooldown === 0) return;

            // Set initial value immediately
            const timePassedInitial = Date.now() - completionTimestamp.toDate().getTime();
            const remainingInitial = cooldown - timePassedInitial;
            if (remainingInitial > 0) {
                const hours = Math.floor(remainingInitial / (1000 * 60 * 60));
                const minutes = Math.floor((remainingInitial % (1000 * 60 * 60)) / (1000 * 60));
                setTimeLeft(`${hours}h ${minutes}m`);
            }

            const interval = setInterval(() => {
                const timePassed = Date.now() - completionTimestamp.toDate().getTime();
                const remaining = cooldown - timePassed;
                if (remaining <= 0) {
                    setTimeLeft('');
                    clearInterval(interval);
                } else {
                    const hours = Math.floor(remaining / (1000 * 60 * 60));
                    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
                    setTimeLeft(`${hours}h ${minutes}m`);
                }
            }, 60000); // Update every minute is sufficient

            return () => clearInterval(interval);
        }, [completionTimestamp, quest.type, isPermanentlyCompleted]);

        const isOnCooldown = !!timeLeft;
        const isClaimable = !isPermanentlyCompleted && !isOnCooldown && quest.canClaim(currentUserProfile);
        const glowClasses = {
            onboarding: 'quest-card-onboarding', daily: 'quest-card-daily', weekly: 'quest-card-weekly',
            monthly: 'quest-card-monthly', milestone: 'quest-card-milestone',
        };

        const buttonBaseClasses = "self-center px-4 py-1 text-white font-bold rounded-full transition duration-300 disabled:cursor-not-allowed w-28 text-center text-sm flex items-center justify-center h-8 disabled:opacity-80";
        const buttonColorClass = isClaimable ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-700';

        return (
            <div className={`p-4 rounded-lg flex items-start space-x-4 transition-all duration-300 bg-gray-900/30 border ${glowClasses[quest.type] || 'border-gray-700'} ${!isClaimable && !isPermanentlyCompleted ? 'opacity-60' : ''}`}>
                <div className="flex-shrink-0 mt-1">
                    {isPermanentlyCompleted || isOnCooldown ? <LucideIcons.CheckCircle2 size={24} className="text-green-400" /> : <LucideIcons.CircleDashed size={24} className="text-blue-400" />}
                </div>
                <div className="flex-grow">
                    <h4 className="font-bold text-white">{quest.title}</h4>
                    <p className="text-sm text-gray-300 mt-1">{quest.description}</p>
                    <p className="text-xs font-bold text-yellow-400 mt-2">REWARD: {quest.reward} ECHOES</p>
                </div>
                {!isPermanentlyCompleted && (
                    <button onClick={() => handleClaimReward(quest.id)} disabled={!isClaimable || claimingId === quest.id} className={`${buttonBaseClasses} ${buttonColorClass}`}>
                        {claimingId === quest.id ? <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white"></div> : (isOnCooldown ? timeLeft : (isClaimable ? 'Claim' : 'Locked'))}
                    </button>
                )}
            </div>
        );
    };

    const QuestCategory = ({ title, questList }) => {
        if (!questList || questList.length === 0) return null;
        return (
            <div>
                <h3 className="text-xl font-bold mb-4 text-blue-200 font-playfair">{title}</h3>
                <div className="space-y-3">
                    {questList.map(q => <QuestCard key={q.id} quest={q} />)}
                </div>
            </div>
        );
    };

    return (
        <div className="animate-fadeIn space-y-8">
            <QuestCategory title="Onboarding Quests" questList={categorizedQuests.onboarding} />
            <QuestCategory title="Daily Quests" questList={categorizedQuests.daily} />
            <QuestCategory title="Weekly Quests" questList={categorizedQuests.weekly} />
            <QuestCategory title="Monthly Quests" questList={categorizedQuests.monthly} />
            <QuestCategory title="Milestones" questList={categorizedQuests.milestones} />
        </div>
    );
}

// In App.js, REPLACE the existing HubTab component with this one.

const HubTab = () => {
    const { LucideIcons, currentUserProfile, handleUserSelect, appFunctions, setMessage, stripePromise, setShowProModal } = useAppContext();
    const [isPurchasing, setIsPurchasing] = useState(false);
    const [showEchoChamber, setShowEchoChamber] = useState(false);
    const [showPayoutSetupModal, setShowPayoutSetupModal] = useState(false);
    const [showConfirmWithdraw, setShowConfirmWithdraw] = useState(false);
    const [chamberTimeLeft, setChamberTimeLeft] = useState('');

    const stripePriceIds = {
        1000: "price_1RuFrR8FT6FNb22O8jKUt7jb",
        2500: "price_1RuFrR8FT6FNb22OsJkb3BTU",
        5500: "price_1RuFrR8FT6FNb22OCXOk6KrT",
        12000: "price_1RuFrR8FT6FNb22OaybHYofS",
    };

    const handleBuyEchoes = useCallback(async (tokens) => {
        setIsPurchasing(true);
        const priceId = stripePriceIds[tokens];
        if (!priceId || priceId.includes('YOUR_')) {
            setMessage("This product is not configured correctly. Please contact support.");
            setIsPurchasing(false);
            return;
        }
        const createStripeCheckoutSession = httpsCallable(appFunctions, 'createStripeCheckoutSession');
        try {
            const result = await createStripeCheckoutSession({ priceId, tokens });
            const { sessionId } = result.data;
            const stripe = await stripePromise;
            await stripe.redirectToCheckout({ sessionId });
        } catch (error) {
            console.error("Error redirecting to Stripe:", error);
            setMessage(`Could not initiate purchase: ${error.message}`);
        } finally {
            setIsPurchasing(false);
        }
    }, [appFunctions, setMessage, stripePromise]);

    const performWithdraw = useCallback(async () => {
        setShowConfirmWithdraw(false);
        const cashOutEchoes = httpsCallable(appFunctions, 'cashOutEchoes');
        try {
            const result = await cashOutEchoes();
            if (result.data.success) {
                setMessage(`Cash out successful! $${result.data.amount.toFixed(2)} is on its way.`);
            } else {
                setMessage(`Cash out failed: ${result.data.error || 'Unknown error'}`);
            }
        } catch (e) {
            console.error("Error cashing out echoes:", e);
            setMessage(`An error occurred during cash out: ${e.message}`);
        }
    }, [appFunctions, setMessage]);

    const handleWithdraw = useCallback(() => {
        const currentEchoes = currentUserProfile?.tokens || 0;
        const MINIMUM_WITHDRAWAL_ECHOES = 500;
        if (currentEchoes < MINIMUM_WITHDRAWAL_ECHOES) {
            setMessage(`You need at least ${MINIMUM_WITHDRAWAL_ECHOES} Echoes to cash out.`);
            return;
        }
        if (!currentUserProfile.stripeAccountId) {
            setMessage("Please set up your payout method first.");
            setShowPayoutSetupModal(true);
            return;
        }
        setShowConfirmWithdraw(true);
    }, [currentUserProfile, setMessage]);

    const canOpenChamber = !currentUserProfile.lastChamberOpen || (Date.now() - currentUserProfile.lastChamberOpen.toDate().getTime()) >= 22 * 60 * 60 * 1000;

    useEffect(() => {
        if (!canOpenChamber && currentUserProfile.lastChamberOpen) {
            const interval = setInterval(() => {
                const timeLeftMs = (22 * 60 * 60 * 1000) - (Date.now() - currentUserProfile.lastChamberOpen.toDate().getTime());
                if (timeLeftMs <= 0) {
                    setChamberTimeLeft('');
                    clearInterval(interval);
                } else {
                    const hours = Math.floor(timeLeftMs / (1000 * 60 * 60));
                    const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));
                    setChamberTimeLeft(`${hours}h ${minutes}m`);
                }
            }, 1000);
            return () => clearInterval(interval);
        }
    }, [canOpenChamber, currentUserProfile.lastChamberOpen]);

    const amountInUSD = (currentUserProfile?.tokens || 0) * 0.01;
    const confirmationMessage = `You are about to cash out ${currentUserProfile?.tokens || 0} Echoes for $${amountInUSD.toFixed(2)}. This action is irreversible. Confirm?`;

    // --- THIS IS THE FIX ---
    const hasStripeAccount = !!currentUserProfile.stripeAccountId;
    // --- END OF FIX ---

    return (
        <div className="animate-fadeIn">
            {showPayoutSetupModal && <PayoutSetupModal onClose={() => setShowPayoutSetupModal(false)} LucideIcons={LucideIcons} />}
            {showEchoChamber && <EchoChamber onClose={() => setShowEchoChamber(false)} />}
            {showConfirmWithdraw && <MessageBox message={confirmationMessage} showConfirm={true} onConfirm={performWithdraw} onClose={() => setShowConfirmWithdraw(false)} />}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 text-center">
                <div className="bg-gray-800 p-4 rounded-lg"><h4 className="text-sm font-bold text-purple-300">ECHOES</h4><p className="text-3xl font-bold text-white flex items-center justify-center"><LucideIcons.Gem size={24} className="mr-2" />{currentUserProfile.tokens || 0}</p></div>
                <div className="bg-gray-800 p-4 rounded-lg"><h4 className="text-sm font-bold text-sky-300">REPUTATION</h4><p className="text-3xl font-bold text-white flex items-center justify-center"><LucideIcons.Shield size={24} className="mr-2" />{currentUserProfile.reputationScore || 0}</p></div>
                <div className="bg-gray-800 p-4 rounded-lg"><h4 className="text-sm font-bold text-yellow-300">VIBE SCORE</h4><p className="text-3xl font-bold text-white flex items-center justify-center"><LucideIcons.Smile size={24} className="mr-2" />{currentUserProfile.vibeScore || 0}</p></div>
            </div>
            <div onClick={() => handleUserSelect(currentUserProfile.id)} className="bg-gray-800/50 p-4 rounded-lg flex items-center mb-6 cursor-pointer hover:bg-gray-700/50 transition-colors">
                <img src={currentUserProfile.photoURL || "https://placehold.co/100x100/AEC6CF/FFFFFF?text=U"} alt={currentUserProfile.displayName} className="w-20 h-20 rounded-full object-cover border-4 border-gray-600 mr-4" />
                <div>
                    <h3 className="text-2xl font-bold text-white">{currentUserProfile.displayName}</h3>
                    <p className="text-md text-gray-300 italic">"{currentUserProfile.bio || 'A seeker of harmony and bliss.'}"</p>
                </div>
            </div>
            <div className="mt-6 pt-6 border-t border-gray-700">
                <h3 className="text-xl font-bold mb-4 text-blue-200 font-playfair">Manage Echoes & Rewards</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="flex flex-col gap-2">
                        <h4 className="text-lg font-semibold text-center text-gray-300 mb-2">Purchase Echoes</h4>
                        <div className="flex flex-col md:grid md:grid-cols-2 gap-2">
                            <button onClick={() => handleBuyEchoes(1000)} disabled={isPurchasing} className="small-action-button bg-green-600 hover:bg-green-700"><LucideIcons.PlusCircle size={16} className="mr-1.5" />1,000</button>
                            <button onClick={() => handleBuyEchoes(2500)} disabled={isPurchasing} className="small-action-button bg-green-600 hover:bg-green-700"><LucideIcons.PlusCircle size={16} className="mr-1.5" />2,500</button>
                            <button onClick={() => handleBuyEchoes(5500)} disabled={isPurchasing} className="small-action-button bg-green-600 hover:bg-green-700"><LucideIcons.PlusCircle size={16} className="mr-1.5" />5,500</button>
                            <button onClick={() => handleBuyEchoes(12000)} disabled={isPurchasing} className="small-action-button bg-green-600 hover:bg-green-700"><LucideIcons.PlusCircle size={16} className="mr-1.5" />12,000</button>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <h4 className="text-lg font-semibold text-center text-gray-300 mb-2">Actions & Rewards</h4>
                        <button onClick={handleWithdraw} disabled={(currentUserProfile.tokens || 0) < 500} className="small-action-button bg-red-600 hover:bg-red-700 disabled:opacity-50"><LucideIcons.Banknote size={16} className="mr-1.5" />Cash Out Echoes</button>
                        {/* --- THIS IS THE FIX --- */}
                        <button onClick={() => setShowPayoutSetupModal(true)} disabled={hasStripeAccount} className="small-action-button bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed">
                            {hasStripeAccount ? <LucideIcons.CheckCircle2 size={16} className="mr-1.5" /> : <LucideIcons.CreditCard size={16} className="mr-1.5" />}
                            {hasStripeAccount ? 'Payouts Configured' : 'Payout Setup'}
                        </button>
                        {/* --- END OF FIX --- */}
                        <button onClick={() => setShowEchoChamber(true)} disabled={!canOpenChamber} className="small-action-button bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
                            <LucideIcons.Gift size={16} className="mr-1.5" />{canOpenChamber ? 'Open Daily Echo Chamber' : `Opens in ${chamberTimeLeft}`}
                        </button>
                        <button onClick={() => setShowProModal(true)} className="small-action-button bg-amber-500 text-black hover:bg-amber-400">
                            <LucideIcons.Crown size={16} className="mr-1.5" />View Harmony Pro
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const CreatorDashboardTab = () => {
    const { userId, db, collection, query, where, getDocs, orderBy, limit, appFunctions, setMessage, currentUserProfile, appId, LucideIcons } = useAppContext();
    const [stats, setStats] = useState({ totalEarnings: 0, subscriberCount: 0 });
    const [topWhispers, setTopWhispers] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [audienceInsight, setAudienceInsight] = useState('');
    const [isLoadingInsight, setIsLoadingInsight] = useState(false);

    useEffect(() => {
        if (!userId || !db) return;
        const fetchDashboardData = async () => {
            setIsLoading(true);
            try {
                const topWhispersQuery = query(collection(db, `artifacts/${appId}/public/data/anonymous_entries`), where("authorId", "==", userId), orderBy("echoesInvested", "desc"), limit(5));
                const topWhispersSnapshot = await getDocs(topWhispersQuery);
                setTopWhispers(topWhispersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
                setStats({
                    totalEarnings: currentUserProfile?.totalEarnings || 0,
                    subscriberCount: currentUserProfile?.subscriberCount || 0,
                });
            } catch (error) {
                console.error("Error fetching creator dashboard data:", error);
                setMessage("Could not load your creator stats.");
            } finally {
                setIsLoading(false);
            }
        };
        fetchDashboardData();
    }, [userId, db, currentUserProfile, appId, collection, query, where, orderBy, limit, getDocs, setMessage]);

    const handleGetAudienceInsight = useCallback(async () => {
        setIsLoadingInsight(true);
        try {
            const getCreatorInsights = httpsCallable(appFunctions, 'getCreatorInsights');
            const result = await getCreatorInsights();
            setAudienceInsight(result.data.insight);
        } catch (e) {
            console.error("Error getting audience insight:", e);
            setMessage("Could not generate audience insights at this time.");
        } finally {
            setIsLoadingInsight(false);
        }
    }, [appFunctions, setMessage]);

    if (isLoading) {
        return <LoadingSpinner message="Loading Creator Stats..." />;
    }

    return (
        <div className="animate-fadeIn space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                <div className="bg-gray-800 p-4 rounded-lg border border-gray-700"><h4 className="text-sm font-bold text-yellow-300">TOTAL ECHOES EARNED</h4><p className="text-3xl font-bold text-white flex items-center justify-center mt-1"><LucideIcons.Flame size={24} className="mr-2" />{stats.totalEarnings}</p></div>
                <div className="bg-gray-800 p-4 rounded-lg border border-gray-700"><h4 className="text-sm font-bold text-purple-300">SEALED KEYHOLDERS</h4><p className="text-3xl font-bold text-white flex items-center justify-center mt-1"><LucideIcons.KeyRound size={24} className="mr-2" />{stats.subscriberCount}</p></div>
                <div className="bg-gray-800 p-4 rounded-lg border border-gray-700"><h4 className="text-sm font-bold text-sky-300">REPUTATION</h4><p className="text-3xl font-bold text-white flex items-center justify-center mt-1"><LucideIcons.ShieldCheck size={24} className="mr-2" />{currentUserProfile?.reputationScore || 0}</p></div>
            </div>
            <div className="bg-gray-800/50 p-5 rounded-lg border border-gray-700">
                <h4 className="text-lg font-bold mb-3 text-blue-200 flex items-center"><LucideIcons.BrainCircuit size={20} className="mr-3 text-purple-400" />AI Audience Insight</h4>
                {audienceInsight ? (<blockquote className="border-l-4 border-purple-400 pl-4 text-gray-300 italic">"{audienceInsight}"</blockquote>) : (<button onClick={handleGetAudienceInsight} disabled={isLoadingInsight} className="w-full small-action-button bg-purple-600 hover:bg-purple-700 transition-all duration-300 disabled:opacity-60">{isLoadingInsight ? 'Analyzing...' : 'Generate Insight (Find out what your audience loves!)'}</button>)}
            </div>
            <div>
                <h3 className="text-xl font-bold mb-4 text-blue-200 font-playfair">Top Performing Whispers</h3>
                {topWhispers.length > 0 ? (<div className="space-y-3">{topWhispers.map(whisper => (<div key={whisper.id} className="bg-gray-800 p-4 rounded-lg flex justify-between items-center"><p className="text-gray-300 italic truncate pr-4">"{whisper.content}"</p><div className="flex-shrink-0 flex items-center space-x-4 text-sm"><div className="flex items-center text-yellow-400" title="Echoes Invested"><LucideIcons.Flame size={16} className="mr-1.5" /><span className="font-bold">{whisper.echoesInvested || 0}</span></div><div className="flex items-center text-pink-400" title="Likes"><LucideIcons.Heart size={16} className="mr-1.5" /><span className="font-bold">{whisper.likesCount || 0}</span></div></div></div>))}</div>) : (<p className="text-gray-400 italic text-center py-4">Your whispers haven't been amplified yet. Keep sharing to grow your influence!</p>)}
            </div>
        </div>
    );
};

const HistoryTab = () => {
    const { userId, db, collection, query, orderBy, limit, onSnapshot, setMessage, appId } = useAppContext();
    const [transactions, setTransactions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!userId || !db) return;
        const transQuery = query(collection(db, `artifacts/${appId}/users/${userId}/transactions`), orderBy("timestamp", "desc"), limit(50));
        const unsubscribe = onSnapshot(transQuery, (snapshot) => {
            setTransactions(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
            setIsLoading(false);
        }, (error) => {
            console.error("Error fetching transaction history:", error);
            setMessage("Could not load transaction history.");
            setIsLoading(false);
        });
        return () => unsubscribe();
    }, [userId, db, appId, collection, query, orderBy, limit, onSnapshot, setMessage]);

    if (isLoading) {
        return <LoadingSpinner message="Loading History..." />;
    }

    return (
        <div className="animate-fadeIn space-y-3 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
            {transactions.length > 0 ? (
                transactions.map(tx => (
                    <div key={tx.id} className="bg-gray-800/70 p-3 rounded-lg flex justify-between items-center">
                        <div>
                            <p className="font-semibold text-white">{tx.description}</p>
                            <p className="text-xs text-gray-400">{tx.timestamp?.toDate().toLocaleString()}</p>
                        </div>
                        <p className={`font-bold text-lg ${tx.amount > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {tx.amount > 0 ? '+' : ''}{tx.amount}
                        </p>
                    </div>
                ))
            ) : (
                <p className="text-center text-gray-400 italic py-8">No transactions found.</p>
            )}
        </div>
    );
};



function WalletHub() {
    const { currentUserProfile } = useAppContext();
    const [activeTab, setActiveTab] = useState('hub');

    const reputationScore = currentUserProfile?.reputationScore || 0;
    const canSeeDashboard = reputationScore >= 250;

    if (!currentUserProfile) {
        return <LoadingSpinner message="Loading Your Hub..." />;
    }


    return (
        <div className="p-4 sm:p-6 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-3xl mx-auto text-white">
            <div className="flex justify-center border-b border-gray-700 mb-6">
                <button onClick={() => setActiveTab('hub')} className={`profile-tab-button ${activeTab === 'hub' ? 'active' : ''}`}>Hub</button>
                <button onClick={() => setActiveTab('quests')} className={`profile-tab-button ${activeTab === 'quests' ? 'active' : ''}`}>Quests</button>
                <button onClick={() => setActiveTab('history')} className={`profile-tab-button ${activeTab === 'history' ? 'active' : ''}`}>History</button>
                {canSeeDashboard && (
                    <button onClick={() => setActiveTab('dashboard')} className={`profile-tab-button ${activeTab === 'dashboard' ? 'active' : ''}`}>Creator Dashboard</button>
                )}
            </div>

            <div className="page-container">
                {activeTab === 'hub' && <HubTab />}
                {activeTab === 'quests' && <QuestBoard />}
                {activeTab === 'history' && <HistoryTab />}
                {activeTab === 'dashboard' && canSeeDashboard && <CreatorDashboardTab />}
            </div>
        </div>
    );
}
const UserListPanel = ({ allUsers, selectedChatUser, onSelectUser, unreadChatPartners, isLoading }) => {
    const { onlineStatus } = useAppContext();

    return (
        <div className="flex flex-col h-full bg-black bg-opacity-20 backdrop-blur-md rounded-2xl overflow-hidden border border-white/10">
            <div className="p-4 border-b border-white/10">
                <h2 className="text-xl sm:text-2xl font-bold text-center text-white font-playfair truncate">Conversations</h2>
            </div>
            {isLoading ? (
                <div className="flex-grow flex items-center justify-center">
                    <LoadingSpinner message="Loading contacts..." />
                </div>
            ) : (
                <div className="flex-grow overflow-y-auto custom-scrollbar">
                    {allUsers.length > 0 ? (
                        allUsers.map(u => {
                            const status = onlineStatus[u.id];
                            const isOnline = status?.state === 'online';

                            // --- THIS IS THE FIX: The entire button is the clickable element ---
                            return (
                                <button
                                    key={u.id}
                                    onClick={() => onSelectUser(u.id, u.displayName)}
                                    className={`w-full text-left p-3 flex items-center gap-4 transition-all duration-200 ease-in-out border-b border-white/5 ${selectedChatUser?.id === u.id ? 'bg-blue-500/30' : 'hover:bg-white/10'}`}
                                >
                                    <div className="relative flex-shrink-0">
                                        <img src={u.photoURL || "https://placehold.co/48x48/AEC6CF/FFFFFF?text=U"} alt={u.displayName} className="w-12 h-12 rounded-full object-cover" />
                                        {isOnline && (
                                            <span className="absolute bottom-0 right-0 block h-3 w-3 rounded-full bg-green-400 ring-2 ring-gray-800" title="Online" />
                                        )}
                                    </div>
                                    <div className="flex-grow truncate">
                                        <p className="font-semibold text-base text-white truncate">{u.displayName}</p>
                                        <p className={`text-sm truncate ${isOnline ? 'text-green-400' : 'text-gray-400'}`}>
                                            {isOnline ? 'Online' : 'Offline'}
                                        </p>
                                    </div>
                                    {unreadChatPartners.includes(u.id) && (
                                        <div className="w-3 h-3 bg-sky-400 rounded-full flex-shrink-0" title="Unread Messages" />
                                    )}
                                </button>
                            );
                        })
                    ) : (
                        <p className="text-center text-gray-400 p-6">No users available to message.</p>
                    )}
                </div>
            )}
        </div>
    );
};
// In App.js, REPLACE the existing ChatPanel component with this final, corrected version.

function ChatPanel({ selectedChatUser, onBackToUsers }) {
    const { userId, db, collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, LucideIcons, appId, appFunctions, userProfiles, setMessage, onlineStatus, doc } = useAppContext();
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [isGeneratingStarter, setIsGeneratingStarter] = useState(false);
    const [showGiftModal, setShowGiftModal] = useState(false);
    const [syncScore, setSyncScore] = useState(0);
    const messagesEndRef = useRef(null);

    const recipientProfile = useMemo(() => userProfiles.find(u => u.id === selectedChatUser.id), [userProfiles, selectedChatUser]);
    const status = onlineStatus[selectedChatUser.id];
    const isOnline = status?.state === 'online';

    useEffect(() => {
        if (selectedChatUser?.id) {
            const markChatAsRead = httpsCallable(appFunctions, 'markChatAsRead');
            markChatAsRead({ chatPartnerId: selectedChatUser.id })
                .catch(err => console.error("Failed to mark chat as read:", err));
        }
    }, [selectedChatUser, appFunctions]);

    useEffect(() => {
        if (!selectedChatUser) return;
        const chatId = [userId, selectedChatUser.id].sort().join('_');
        const q = query(collection(db, `artifacts/${appId}/private_chats/${chatId}/messages`), orderBy("timestamp", "asc"));
        const unsubMessages = onSnapshot(q, (snapshot) => {
            setMessages(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        });

        const chatRef = doc(db, `artifacts/${appId}/private_chats/${chatId}`);
        const unsubChat = onSnapshot(chatRef, (docSnap) => {
            setSyncScore(docSnap.exists() ? docSnap.data().syncScore || 0 : 0);
        });

        return () => { unsubMessages(); unsubChat(); };
    }, [selectedChatUser, userId, db, appId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    const handleSendMessage = useCallback(async (e) => {
        e.preventDefault();
        if (!newMessage.trim() || !selectedChatUser) return;
        const tempMessage = newMessage;
        setNewMessage('');
        try {
            const chatId = [userId, selectedChatUser.id].sort().join('_');
            await addDoc(collection(db, `artifacts/${appId}/private_chats/${chatId}/messages`), {
                from: userId, to: selectedChatUser.id, content: tempMessage.trim(),
                timestamp: serverTimestamp(), read: false,
            });
        } catch (error) {
            console.error("Error sending message:", error);
            setMessage(`Failed to send message: ${error.message}`);
            setNewMessage(tempMessage);
        }
    }, [newMessage, selectedChatUser, userId, db, appId, setMessage]);

    const handleGenerateStarter = async () => {
        setIsGeneratingStarter(true);
        const generateConversationStarter = httpsCallable(appFunctions, 'generateConversationStarter');
        try {
            const result = await generateConversationStarter({ recipientId: selectedChatUser.id });
            setNewMessage(result.data.starter);
        } catch (error) {
            console.error("Error generating starter:", error);
            setMessage(`AI failed to generate a starter: ${error.message}`);
        } finally {
            setIsGeneratingStarter(false);
        }
    };

    const handleReact = useCallback(async (messageId, emoji) => {
        const reactToPrivateMessage = httpsCallable(appFunctions, 'reactToPrivateMessage');
        const chatId = [userId, selectedChatUser.id].sort().join('_');
        try {
            await reactToPrivateMessage({ chatId, messageId, emoji });
        } catch (error) {
            console.error("Failed to react to message:", error);
            setMessage(`Reaction failed: ${error.message}`);
        }
    }, [appFunctions, userId, selectedChatUser, setMessage]);


    const handleSendGift = async (amount, giftMessage) => {
        setShowGiftModal(false);
        if (!amount || amount <= 0) {
            setMessage("Gift amount must be a positive number.");
            return;
        }
        const giftEchoes = httpsCallable(appFunctions, 'giftEchoes');
        try {
            await giftEchoes({
                recipientId: selectedChatUser.id, amount: Number(amount), message: giftMessage
            });
            setMessage("Gift sent successfully!");
        } catch (error) {
            console.error("Error sending gift:", error);
            setMessage(`Gifting failed: ${error.message}`);
        }
    };

    const GiftModal = () => {
        const [amount, setAmount] = useState(10);
        const [giftMessage, setGiftMessage] = useState('');
        return (
            <div className="modal-overlay">
                <div className="bg-gray-800 p-6 rounded-lg shadow-xl max-w-sm w-full text-white relative">
                    <h3 className="text-xl font-bold mb-4 text-yellow-300 font-playfair">Send a Gift of Echoes</h3>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-bold mb-2 text-gray-300">Amount</label>
                            <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} min="1" className="shadow appearance-none border rounded-lg w-full py-2 px-3 bg-gray-900 text-white" />
                        </div>
                        <div>
                            <label className="block text-sm font-bold mb-2 text-gray-300">Optional Message</label>
                            <input type="text" value={giftMessage} onChange={(e) => setGiftMessage(e.target.value)} maxLength="50" placeholder="A little something for you!" className="shadow appearance-none border rounded-lg w-full py-2 px-3 bg-gray-900 text-white" />
                        </div>
                    </div>
                    <div className="flex justify-end gap-4 mt-6">
                        <button onClick={() => setShowGiftModal(false)} className="px-4 py-2 bg-gray-600 rounded-md hover:bg-gray-700">Cancel</button>
                        <button onClick={() => handleSendGift(amount, giftMessage)} className="px-4 py-2 bg-yellow-500 text-black font-bold rounded-md hover:bg-yellow-400">Send Gift</button>
                    </div>
                </div>
            </div>
        );
    };

    const HarmonyMeter = () => (
        <div className="w-full bg-gray-700/50 rounded-full h-1 absolute bottom-0 left-0">
            <div className="bg-gradient-to-r from-purple-500 to-pink-500 h-1 rounded-full transition-all duration-500" style={{ width: `${syncScore * 10}%` }}></div>
        </div>
    );

    return (
        <div className="flex flex-col h-[80vh] max-h-[700px] bg-black bg-opacity-20 backdrop-blur-md rounded-2xl overflow-hidden border border-white/10">
            {showGiftModal && <GiftModal />}
            <div className="relative flex items-center p-4 border-b border-white/10 gap-4 flex-shrink-0">
                <button onClick={onBackToUsers} className="p-2 rounded-full hover:bg-white/10 md:hidden">
                    <LucideIcons.ArrowLeft size={20} className="text-white" />
                </button>
                <div className="relative flex-shrink-0">
                    <img src={recipientProfile?.photoURL || "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U"} alt={selectedChatUser.displayName} className="w-10 h-10 rounded-full object-cover" />
                    {isOnline && (
                        <span className="absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full bg-green-400 ring-2 ring-gray-800" />
                    )}
                </div>
                <div>
                    <h2 className="text-lg font-bold text-white">{selectedChatUser.displayName}</h2>
                    <p className={`text-xs font-semibold ${isOnline ? 'text-green-400' : 'text-gray-400'}`}>
                        {isOnline ? 'Online' : 'Offline'}
                    </p>
                </div>
                <HarmonyMeter />
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0">
                <div className="p-6 space-y-2">
                    {messages.map((msg, index) => {
                        if (msg.isHarmonySync) {
                            return (
                                <div key={msg.id} className="text-center text-xs text-purple-300 bg-purple-900/30 rounded-full py-1.5 px-4 my-4 flex items-center justify-center gap-2 max-w-xs mx-auto">
                                    <LucideIcons.Sparkles size={14} /> {msg.content}
                                </div>
                            );
                        }
                        if (msg.isGift) {
                            return (
                                <div key={msg.id} className="text-center text-xs text-yellow-300 bg-yellow-900/30 rounded-full py-1.5 px-4 my-4 flex items-center justify-center gap-2 max-w-xs mx-auto">
                                    <LucideIcons.Gift size={12} /> {msg.content}
                                </div>
                            );
                        }
                        const isUser = msg.from === userId;
                        const prevMessage = messages[index - 1];
                        const showAvatar = !prevMessage || prevMessage.from !== msg.from || prevMessage.isGift || prevMessage.isHarmonySync;
                        return (
                            <div key={msg.id}>
                                <div className={`flex items-end gap-3 ${isUser ? 'flex-row-reverse' : ''} ${!showAvatar ? 'mt-1' : 'mt-4'}`}>
                                    <div className="w-8 flex-shrink-0">
                                        {showAvatar && (
                                            <img
                                                src={(isUser ? userProfiles.find(u => u.id === userId)?.photoURL : recipientProfile?.photoURL) || "https://placehold.co/32x32/AEC6CF/FFFFFF?text=U"}
                                                alt="avatar"
                                                className="w-8 h-8 rounded-full object-cover"
                                            />
                                        )}
                                    </div>
                                    {/* --- THIS IS THE FIX --- */}
                                    {/* The max-width is now responsive: 85% on mobile, 70% on medium screens and up. */}
                                    <div className={`max-w-[100%] md:max-w-[70%] p-3 rounded-2xl ${isUser ? 'bg-blue-600 text-white rounded-br-md' : 'bg-gray-700 text-gray-100 rounded-bl-md'}`}>
                                        <p className="text-sm leading-relaxed break-words">{msg.content}</p>
                                    </div>
                                </div>
                                {(msg.from !== 'system' && !msg.isHarmonySync && !msg.isGift) && (
                                    <ReactionBar message={msg} onReact={handleReact} isUser={isUser} />
                                )}
                            </div>
                        );
                    })}
                    <div ref={messagesEndRef} />
                </div>
            </div>
            <form onSubmit={handleSendMessage} className="p-4 border-t border-white/10 flex items-center gap-2 flex-shrink-0">
                <HoverTooltip text="Generate an AI conversation starter">
                    <button type="button" onClick={handleGenerateStarter} disabled={isGeneratingStarter} className="p-2 rounded-full text-purple-400 hover:bg-white/10 transition-colors">
                        {isGeneratingStarter ? <div className="action-spinner" /> : <LucideIcons.Sparkles size={20} />}
                    </button>
                </HoverTooltip>
                <HoverTooltip text="Send a Gift of Echoes">
                    <button type="button" onClick={() => setShowGiftModal(true)} className="p-2 rounded-full text-yellow-400 hover:bg-white/10 transition-colors">
                        <LucideIcons.Gift size={20} />
                    </button>
                </HoverTooltip>
                <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder="Type a message..."
                    className="flex-1 bg-gray-900/50 rounded-full py-2 px-4 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                />
                <button type="submit" className="p-2 rounded-full text-blue-400 hover:bg-blue-500/20 disabled:opacity-50 transition-colors" disabled={!newMessage.trim()}>
                    <LucideIcons.Send size={20} />
                </button>
            </form>
        </div>
    );
};

function MessagesPage() {
    const { userId, db, collection, onSnapshot, appId, userProfiles, handlePageChange } = useAppContext();
    const [allUsers, setAllUsers] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedChatUser, setSelectedChatUser] = useState(null);
    const currentUserProfile = userProfiles.find(p => p.id === userId);
    const unreadChatPartners = currentUserProfile?.unreadChatPartners || [];

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const chatPartnerId = params.get('chatPartnerId');
        if (chatPartnerId) {
            const profile = userProfiles.find(p => p.id === chatPartnerId);
            if (profile) {
                setSelectedChatUser({ id: profile.id, displayName: profile.displayName });
            }
        }
    }, [userProfiles]);

    useEffect(() => {
        if (!db || !userId) return;
        const unsubUsers = onSnapshot(collection(db, `artifacts/${appId}/public/data/user_profiles`), (snap) => {
            const usersData = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.id !== userId && !u.isAI);
            usersData.sort((a, b) => {
                const aUnread = unreadChatPartners.includes(a.id);
                const bUnread = unreadChatPartners.includes(b.id);
                if (aUnread && !bUnread) return -1;
                if (!aUnread && bUnread) return 1;
                return 0;
            });
            setAllUsers(usersData);
            setIsLoading(false);
        });
        return () => unsubUsers();
    }, [userId, db, appId, collection, onSnapshot, unreadChatPartners]);

    const handleSelectUserForMessage = (targetId, targetName) => {
        handlePageChange('messages', { chatPartnerId: targetId });
        setSelectedChatUser({ id: targetId, displayName: targetName });
    };

    const handleBackToUsers = () => {
        handlePageChange('messages');
        setSelectedChatUser(null);
    };

    return (
        <div className="max-w-6xl mx-auto">
            <div className="grid md:grid-cols-12 gap-6 messages-page-grid">
                <div className={`md:col-span-4 min-w-0 ${selectedChatUser ? 'hidden md:block' : 'block'}`}>
                    <UserListPanel
                        allUsers={allUsers}
                        selectedChatUser={selectedChatUser}
                        onSelectUser={handleSelectUserForMessage}
                        unreadChatPartners={unreadChatPartners}
                        isLoading={isLoading}
                    />
                </div>

                {/* --- THIS IS THE FIX --- */}
                {/* The column span for the chat panel has been changed from md:col-span-4 to md:col-span-8 */}
                <div className={`md:col-span-8 min-w-0 ${selectedChatUser ? 'block' : 'hidden md:flex'}`}>
                    {selectedChatUser ? (
                        <ChatPanel selectedChatUser={selectedChatUser} onBackToUsers={handleBackToUsers} />
                    ) : (
                        <div className="h-full w-full flex items-center justify-center bg-black bg-opacity-20 backdrop-blur-md rounded-2xl border border-white/10" style={{ minHeight: '60vh' }}>
                            <div className="text-center text-gray-400">
                                <LucideIcons.MessageSquareText size={48} className="mx-auto mb-4" />
                                <h3 className="text-xl font-semibold text-white">Select a conversation</h3>
                                <p>Choose a contact from the list to start chatting.</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}


const UserCard = ({ profile, onUserSelect }) => {
    const { LucideIcons, onlineStatus, setMediaToView } = useAppContext();
    const status = onlineStatus[profile.id];
    const isOnline = status?.state === 'online';

    // --- THIS IS THE FIX: The entire card is now clickable ---
    return (
        <div
            onClick={() => onUserSelect(profile.id)}
            className="bg-gray-800/70 p-4 rounded-lg flex flex-col items-center text-center transition-all duration-300 hover:bg-gray-700/90 hover:scale-105 cursor-pointer"
        >
            <div className="relative">
                {/* The image remains clickable for media viewing, but stops the navigation event */}
                <img
                    onClick={(e) => { e.stopPropagation(); setMediaToView(profile.photoURL); }}
                    src={profile.photoURL || "https://placehold.co/100x100/AEC6CF/FFFFFF?text=U"}
                    alt={profile.displayName}
                    className="w-24 h-24 rounded-full object-cover border-4 border-gray-600"
                />
                {isOnline && <span className="absolute bottom-1 right-1 w-4 h-4 bg-green-400 rounded-full border-2 border-gray-800" title="Online"></span>}
                {profile.isAI && <span className="absolute top-1 right-1 p-1 bg-purple-500 rounded-full" title="AI Persona"><LucideIcons.BrainCircuit size={12} className="text-white" /></span>}
            </div>
            <div className="w-full mt-3">
                <h4 className="font-bold text-white truncate w-full">{profile.displayName}</h4>
                <p className="text-xs text-gray-400 truncate w-full">{profile.interests?.join(', ') || 'Exploring the cosmos'}</p>
            </div>
        </div>
    );
};

function UsersList({ onUserSelect }) {
    const { userProfiles, onlineStatus } = useAppContext();
    const [activeTab, setActiveTab] = useState('online');

    const { onlineUsers, allUsers, aiUsers } = useMemo(() => {
        const online = [];
        const all = [];
        const ai = [];

        userProfiles.forEach(p => {
            if (p.isAI) {
                ai.push(p);
            } else {
                all.push(p);
                const status = onlineStatus[p.id];
                if (status?.state === 'online') {
                    online.push(p);
                }
            }
        });
        return { onlineUsers: online, allUsers: all, aiUsers: ai };
    }, [userProfiles, onlineStatus]);

    const renderList = (list, emptyMessage) => {
        if (list.length === 0) {
            return <p className="text-center text-gray-400 italic mt-8">{emptyMessage}</p>;
        }

        const Row = ({ index, style }) => (
            <div style={style} className="p-2">
                <UserCard profile={list[index]} onUserSelect={onUserSelect} />
            </div>
        );

        return (
            <div className="w-full h-[60vh]">
                <List
                    height={window.innerHeight * 0.6}
                    itemCount={list.length}
                    itemSize={180}
                    width="100%"
                >
                    {Row}
                </List>
            </div>
        );
    };

    const listToRender = activeTab === 'online' ? onlineUsers : activeTab === 'all' ? allUsers : aiUsers;
    const emptyMessage = activeTab === 'online' ? "No users are currently online." : activeTab === 'all' ? "No other users found." : "No AI personas found.";

    return (
        <div className="p-4 sm:p-6 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-4xl mx-auto text-white">
            <h2 className="text-3xl font-bold text-center mb-6 text-blue-300 font-playfair">Discover Beings</h2>

            <div className="flex justify-center border-b border-gray-700 mb-6">
                <button onClick={() => setActiveTab('online')} className={`px-4 py-2 text-sm font-semibold ${activeTab === 'online' ? 'text-white border-b-2 border-green-400' : 'text-gray-400'}`}>Online</button>
                <button onClick={() => setActiveTab('all')} className={`px-4 py-2 text-sm font-semibold ${activeTab === 'all' ? 'text-white border-b-2 border-blue-400' : 'text-gray-400'}`}>All Users</button>
                <button onClick={() => setActiveTab('ai')} className={`px-4 py-2 text-sm font-semibold ${activeTab === 'ai' ? 'text-white border-b-2 border-purple-400' : 'text-gray-400'}`}>AI Personas</button>
            </div>

            {renderList(listToRender, emptyMessage)}
        </div>
    );
}

// In App.js, REPLACE the entire UserProfile component with this definitive version.
// In App.js, REPLACE the entire UserProfile component and its sub-components with this definitive version.

// --- STEP 1: Define Sub-Components at the top level for performance and clarity ---

const PersonalitySnapshotDisplay = ({ snapshot, LucideIcons }) => {
    const traits = [
        { name: 'Openness', score: snapshot.openness, description: 'Curiosity and creativity', icon: LucideIcons.BrainCircuit },
        { name: 'Conscientiousness', score: snapshot.conscientiousness, description: 'Organized and dependable', icon: LucideIcons.ListChecks },
        { name: 'Extraversion', score: snapshot.extraversion, description: 'Sociable and energetic', icon: LucideIcons.Sun },
        { name: 'Agreeableness', score: snapshot.agreeableness, description: 'Compassionate and cooperative', icon: LucideIcons.HeartHandshake },
        { name: 'Neuroticism', score: snapshot.neuroticism, description: 'Sensitivity to stress', icon: LucideIcons.CloudRain },
    ];
    const TraitBar = ({ trait }) => {
        const Icon = trait.icon;
        return (
            <div>
                <div className="flex justify-between items-center mb-1">
                    <div className="flex items-center gap-2">
                        <Icon size={16} className="text-blue-300" />
                        <span className="font-bold text-white">{trait.name}</span>
                    </div>
                    <span className="text-sm font-mono text-gray-300">{trait.score}%</span>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-2.5"><div className="bg-blue-500 h-2.5 rounded-full" style={{ width: `${trait.score}%` }}></div></div>
                <p className="text-xs text-gray-400 mt-1">{trait.description}</p>
            </div>
        );
    };
    return (
        <div className="mt-6 p-4 bg-gray-800/50 rounded-lg border border-blue-500/20 animate-fadeIn">
            <h3 className="text-xl font-bold text-blue-200 font-playfair mb-3">AI Personality Snapshot</h3>
            <blockquote className="border-l-4 border-blue-400 pl-4 text-gray-300 italic mb-4">"{snapshot.summary}"</blockquote>
            <div className="space-y-4">{traits.map(trait => <TraitBar key={trait.name} trait={trait} />)}</div>
        </div>
    );
};

const ConnectionCompassDisplay = ({ snapshot, LucideIcons }) => {
    const scoreColor = snapshot.compatibilityScore > 70 ? 'text-green-400' : snapshot.compatibilityScore > 40 ? 'text-yellow-400' : 'text-red-400';
    return (
        <div className="mt-6 p-4 bg-gray-800/50 rounded-lg border border-purple-500/20 animate-fadeIn">
            <h3 className="text-xl font-bold text-purple-200 font-playfair mb-3">AI Connection Compass</h3>
            <div className="text-center mb-4">
                <p className="text-sm text-gray-400">Compatibility Score</p>
                <p className={`text-6xl font-bold ${scoreColor}`}>{snapshot.compatibilityScore}</p>
                <div className="w-full bg-gray-700 rounded-full h-2.5 mt-2"><div className="bg-purple-500 h-2.5 rounded-full" style={{ width: `${snapshot.compatibilityScore}%` }}></div></div>
            </div>
            <blockquote className="border-l-4 border-purple-400 pl-4 text-gray-300 italic mb-4">"{snapshot.summary}"</blockquote>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <h4 className="font-bold text-green-400 mb-2 flex items-center gap-2"><LucideIcons.Zap size={16} /> Potential Syncs</h4>
                    <ul className="list-disc list-inside space-y-1 text-sm text-gray-200">{snapshot.syncs.map((sync, i) => <li key={i}>{sync}</li>)}</ul>
                </div>
                <div>
                    <h4 className="font-bold text-red-400 mb-2 flex items-center gap-2"><LucideIcons.ShieldAlert size={16} /> Potential Dissonances</h4>
                    <ul className="list-disc list-inside space-y-1 text-sm text-gray-200">{snapshot.dissonances.map((dis, i) => <li key={i}>{dis}</li>)}</ul>
                </div>
            </div>
        </div>
    );
};

const BioEnhancerModal = ({ suggestions, onSelect, onClose, LucideIcons }) => (
    <div className="modal-overlay">
        <div className="bg-gray-900/80 backdrop-blur-md p-6 rounded-lg shadow-glow max-w-md w-full text-white relative border border-teal-500/50">
            <h3 className="text-xl font-bold mb-4 text-teal-300 font-playfair">AI Bio Suggestions</h3>
            <p className="text-gray-300 mb-6">Choose a new bio or close this window to keep your current one.</p>
            <div className="space-y-3">
                {suggestions.map((bio, index) => (
                    <button key={index} onClick={() => onSelect(bio)} className="w-full text-left p-3 bg-gray-800/60 rounded-lg border border-gray-700 hover:bg-teal-500/20 hover:border-teal-500 transition-all">
                        <p className="italic text-gray-200">"{bio}"</p>
                    </button>
                ))}
            </div>
            <button onClick={onClose} className="absolute top-3 right-3 p-2 rounded-full bg-gray-700/50 hover:bg-gray-600/50 transition duration-300" aria-label="Close"><LucideIcons.X size={20} /></button>
        </div>
    </div>
);

const ThematicCloudDisplay = ({ cloud, LucideIcons }) => {
    const colorClasses = { 1: 'text-sky-400', 2: 'text-teal-300', 3: 'text-gray-100', 4: 'text-purple-300', 5: 'text-amber-300 font-bold' };
    return (
        <div className="mt-6 p-4 bg-gray-800/50 rounded-lg border border-sky-500/20 animate-fadeIn">
            <h3 className="text-xl font-bold text-sky-200 font-playfair mb-4">Thematic Soul-Cloud</h3>
            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4 p-4">
                {cloud.themes.map(({ theme, weight }) => (
                    <span key={theme} className={`transition-all duration-300 ${colorClasses[weight]}`} style={{ fontSize: `${1 + (weight / 5) * 1.25}rem`, opacity: 0.6 + (weight / 5) * 0.4 }}>
                        {theme}
                    </span>
                ))}
            </div>
        </div>
    );
};

const MyWhispersTab = ({ whispers, loadingStates, currentUserProfile, onSpotlight, onAiAction, onDelete, showConfirmation }) => {
    const { LucideIcons } = useAppContext();
    if (whispers.length === 0) return (
        <div className="text-center text-gray-300 p-8 bg-gray-800/50 rounded-lg">
            <LucideIcons.Archive size={48} className="mx-auto mb-4 text-blue-400" />
            <h3 className="text-xl font-bold">Your Archive is Empty</h3>
            <p className="mt-2">You haven't written any whispers yet, or no whispers match your search.</p>
        </div>
    );
    const MemoryCard = ({ entry }) => {
        const isLoading = loadingStates[entry.id];
        const canSpotlight = (currentUserProfile?.influenceScore || 0) >= 1000;
        return (
            <div className="memory-card" tabIndex="0">
                <div className="memory-card-inner">
                    <div className="memory-card-front custom-scrollbar overflow-y-auto">
                        <p className="text-xs text-gray-400 mb-2">{entry.timestamp?.toDate().toLocaleDateString()}</p>
                        {entry.content && <p className="italic text-gray-200 mb-2">"{entry.content}"</p>}
                        <UniversalMediaRenderer entry={entry} />
                        <div className="mt-auto text-center text-xs text-blue-300 pt-2 font-semibold memory-card-prompt">Tap to Manage</div>
                    </div>
                    <div className="memory-card-back">
                        {isLoading ? <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-blue-400"></div> : <>
                            <button onClick={() => showConfirmation({ message: `Spotlight this whisper for 1000 Influence?`, onConfirm: () => onSpotlight(entry.id) })} className="small-action-button bg-yellow-500 hover:bg-yellow-600 text-black w-40 justify-center disabled:opacity-50" disabled={!canSpotlight}><LucideIcons.Star size={14} className="mr-2" /> Spotlight</button>
                            <button onClick={() => showConfirmation({ message: `Generate an AI Summary?`, onConfirm: () => onAiAction('Summary', entry) })} className="small-action-button bg-sky-600 hover:bg-sky-700 w-40 justify-center"><LucideIcons.MessageSquareQuote size={14} className="mr-2" /> Summary</button>
                            <button onClick={() => showConfirmation({ message: `Analyze Sentiment with AI?`, onConfirm: () => onAiAction('Sentiment', entry) })} className="small-action-button bg-purple-600 hover:bg-purple-700 w-40 justify-center"><LucideIcons.TrendingUp size={14} className="mr-2" /> Sentiment</button>
                            <button onClick={() => showConfirmation({ message: "Permanently delete this whisper?", onConfirm: () => onDelete(entry.id) })} className="small-action-button bg-red-600 hover:bg-red-700 w-40 justify-center"><LucideIcons.Trash2 size={14} className="mr-2" /> Delete</button>
                        </>}
                    </div>
                </div>
            </div>
        );
    };
    return <div className="memory-lane-container">{whispers.map(entry => <MemoryCard key={entry.id} entry={entry} />)}</div>;
};

const ProfileWhispersTab = ({ whispers }) => {
    const { LucideIcons } = useAppContext();
    if (whispers.length === 0) return (
        <div className="text-center text-gray-300 p-8 bg-gray-800/50 rounded-lg">
            <LucideIcons.Wind size={48} className="mx-auto mb-4 text-blue-400" />
            <h3 className="text-xl font-bold">The Air is Quiet</h3>
            <p className="mt-2">This user hasn't shared any public whispers yet.</p>
        </div>
    );
    return <div className="space-y-4">{whispers.map(entry => <div key={entry.id} className="bg-gray-800/50 p-4 rounded-lg"><p className="text-xs text-gray-400 mb-2">{entry.timestamp?.toDate().toLocaleString()}</p><p className="italic text-gray-200">"{entry.content}"</p><UniversalMediaRenderer entry={entry} /></div>)}</div>;
};

const ProfileMediaTab = ({ whispers, onDelete, showConfirmation, isSelf }) => {
    const { LucideIcons, setMediaToView } = useAppContext();
    const mediaItems = whispers.filter(w => w.mediaData && w.mediaType !== 'video');
    if (mediaItems.length === 0) return <p className="text-center text-gray-400 italic py-8">This user hasn't shared any media yet.</p>;
    return <div className="media-grid">{mediaItems.map(item => <div key={item.id} className="media-grid-item"><UniversalMediaRenderer entry={item} /><div className="media-grid-overlay" onClick={() => setMediaToView(item.mediaData)}><LucideIcons.Expand size={32} className="text-white" /></div>{isSelf && (<button onClick={(e) => { e.stopPropagation(); showConfirmation({ message: "Permanently delete this whisper and its media?", onConfirm: () => onDelete(item.id) }) }} className="absolute top-2 right-2 p-1.5 bg-red-600/80 text-white rounded-full hover:bg-red-500 transition-colors" aria-label="Delete Media"><LucideIcons.Trash2 size={14} /></button>)}</div>)}</div>;
};

const ProfileNexusesTab = ({ nexuses }) => {
    if (nexuses.length === 0) return <p className="text-center text-gray-400 italic py-8">This user has not joined any Nexuses yet.</p>;
    return <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{nexuses.map(nexus => <NexusCard key={nexus.id} nexus={nexus} />)}</div>;
};


function UserProfile({ profileUserId, onMessageUser, onToggleConnection }) {
    const { userId, userProfiles, db, collection, query, where, orderBy, limit, startAfter, getDocs, appId, userConnections, LucideIcons, updateUserProfile, setMessage, setMediaToView, uploadFile, appFunctions, showConfirmation, TOKEN_COSTS, currentUserProfile, updateUserProfileInState } = useAppContext();

    const [userPublicWhispers, setUserPublicWhispers] = useState([]);
    const [lastVisibleWhisper, setLastVisibleWhisper] = useState(null);
    const [hasMoreWhispers, setHasMoreWhispers] = useState(true);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [activeTab, setActiveTab] = useState('whispers');
    const [isUploading, setIsUploading] = useState(false);
    const avatarInputRef = useRef(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [loadingStates, setLoadingStates] = useState({});
    const debouncedSearchTerm = useDebounce(searchTerm, 500);
    const [aiModalContent, setAiModalContent] = useState({ title: '', content: '' });
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [personalitySnapshot, setPersonalitySnapshot] = useState(null);
    const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false);
    const [connectionCompass, setConnectionCompass] = useState(null);
    const [isLoadingCompass, setIsLoadingCompass] = useState(false);
    const [bioSuggestions, setBioSuggestions] = useState([]);
    const [showBioModal, setShowBioModal] = useState(false);
    const [isEnhancingBio, setIsEnhancingBio] = useState(false);
    const [thematicCloud, setThematicCloud] = useState(null);
    const [isLoadingCloud, setIsLoadingCloud] = useState(false);
    const [echoesOfTomorrow, setEchoesOfTomorrow] = useState(null);
    const [isLoadingEchoes, setIsLoadingEchoes] = useState(false);
    const [userNexuses, setUserNexuses] = useState([]);

    const profileUser = userProfiles.find(p => p.id === profileUserId);
    const isSelf = userId === profileUserId;
    const isConnected = userConnections.some(c => c.followingId === profileUserId);
    const canModerate = currentUserProfile && ['moderator', 'admin', 'owner'].includes(currentUserProfile.role);

    const [isEditing, setIsEditing] = useState(false);
    const [editDisplayName, setEditDisplayName] = useState('');
    const [editBio, setEditBio] = useState('');
    const [editInterests, setEditInterests] = useState('');

    const badgeConfig = useMemo(() => ({
        'respected_voice': { name: 'Respected Voice (Reputation > 100)', icon: LucideIcons.Star, color: 'text-yellow-400' },
        'community_pillar': { name: 'Community Pillar (Reputation > 500)', icon: LucideIcons.ShieldCheck, color: 'text-sky-400' },
        'echo_weaver': { name: 'Echo Weaver (Earned > 1,000)', icon: LucideIcons.Gem, color: 'text-purple-400' },
        'echo_magnate': { name: 'Echo Magnate (Earned > 10,000)', icon: LucideIcons.Crown, color: 'text-amber-300' },
    }), [LucideIcons]);

    const fetchWhispers = useCallback(async (loadMore = false, cursor = null) => {
        if (!profileUserId) return;
        if (loadMore) setIsLoadingMore(true); else setIsLoading(true);

        let q = query(
            collection(db, `artifacts/${appId}/public/data/anonymous_entries`),
            where("authorId", "==", profileUserId),
            orderBy("timestamp", "desc"),
            limit(9)
        );

        if (loadMore && cursor) {
            q = query(q, startAfter(cursor));
        }

        try {
            const whispersSnapshot = await getDocs(q);
            const newWhispers = whispersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const lastDoc = whispersSnapshot.docs[whispersSnapshot.docs.length - 1];
            setLastVisibleWhisper(lastDoc || null);
            setHasMoreWhispers(newWhispers.length === 9);

            setUserPublicWhispers(prev => loadMore ? [...prev, ...newWhispers] : newWhispers);
        } catch (error) {
            console.error("Error fetching whispers:", error);
            setMessage("Could not load whispers.");
        } finally {
            if (!loadMore) setIsLoading(false);
            setIsLoadingMore(false);
        }
    }, [profileUserId, db, appId, setMessage]);

    useEffect(() => {
        if (profileUserId) {
            setUserPublicWhispers([]);
            setLastVisibleWhisper(null);
            setHasMoreWhispers(true);
            setPersonalitySnapshot(null);
            setConnectionCompass(null);
            setThematicCloud(null);
            setEchoesOfTomorrow(null);

            fetchWhispers(false, null);

            const fetchNexuses = async () => {
                const nexusesQuery = query(collection(db, `artifacts/${appId}/public/data/nexuses`), where("memberIds", "array-contains", profileUserId));
                const nexusesSnapshot = await getDocs(nexusesQuery);
                setUserNexuses(nexusesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
            };
            fetchNexuses();
        }
    }, [profileUserId]);

    useEffect(() => {
        if (profileUser) {
            setEditDisplayName(profileUser.displayName || '');
            setEditBio(profileUser.bio || '');
            setEditInterests(profileUser.interests?.join(', ') || '');
        }
    }, [profileUser]);

    const handleDeleteWhisper = useCallback(async (entryId) => {
        const deleteWhisper = httpsCallable(appFunctions, 'deleteWhisper');
        try {
            await deleteWhisper({ whisperId: entryId });
            setMessage('Whisper deleted successfully!');
            setUserPublicWhispers(prev => prev.filter(w => w.id !== entryId));
        } catch (e) {
            setMessage(`Failed to delete whisper: ${e.message}`);
        }
    }, [appFunctions, setMessage]);

    const handleWhisperAiAction = useCallback(async (actionType, entry) => {
        setLoadingStates(prev => ({ ...prev, [entry.id]: true }));
        const analysisMap = { 'Summary': 'PUBLIC_SUMMARY', 'Sentiment': 'PUBLIC_SENTIMENT' };
        try {
            const getAnalysis = httpsCallable(appFunctions, 'getAiAnalysis');
            const result = await getAnalysis({ entryId: entry.id, analysisType: analysisMap[actionType], content: entry.content });
            setAiModalContent({ title: `${actionType} for your Whisper`, content: result.data.text });
            setIsModalOpen(true);
        } catch (e) { setMessage(`Error generating ${actionType}: ${e.message}`); }
        finally { setLoadingStates(prev => ({ ...prev, [entry.id]: false })); }
    }, [appFunctions, setMessage]);

    const handleSetSpotlight = useCallback(async (entryId) => {
        setLoadingStates(prev => ({ ...prev, [entryId]: true }));
        const setSpotlightFn = httpsCallable(appFunctions, 'setSpotlight');
        try { await setSpotlightFn({ whisperId: entryId }); setMessage("Your whisper is now in the spotlight!"); }
        catch (error) { setMessage(`Failed to set spotlight: ${error.message}`); }
        finally { setLoadingStates(prev => ({ ...prev, [entryId]: false })); }
    }, [appFunctions, setMessage]);

    const handleGetSnapshot = useCallback(async () => {
        setIsLoadingSnapshot(true);
        try { const result = await httpsCallable(appFunctions, 'getPersonalitySnapshot')({ targetUserId: profileUserId }); setPersonalitySnapshot(result.data); }
        catch (error) { setMessage(`Analysis failed: ${error.message}`); }
        finally { setIsLoadingSnapshot(false); }
    }, [appFunctions, profileUserId, setMessage]);

    const handleGetCompass = useCallback(async () => {
        setIsLoadingCompass(true);
        try { const result = await httpsCallable(appFunctions, 'getConnectionCompass')({ targetUserId: profileUserId }); setConnectionCompass(result.data); }
        catch (error) { setMessage(`Analysis failed: ${error.message}`); }
        finally { setIsLoadingCompass(false); }
    }, [appFunctions, profileUserId, setMessage]);

    const handleEnhanceBio = useCallback(async () => {
        setIsEnhancingBio(true);
        try {
            const result = await httpsCallable(appFunctions, 'enhanceBio')({ currentBio: editBio });
            if (result.data.suggestions?.length > 0) { setBioSuggestions(result.data.suggestions); setShowBioModal(true); }
            else { setMessage("The AI couldn't generate suggestions."); }
        } catch (error) { setMessage(`Bio enhancement failed: ${error.message}`); }
        finally { setIsEnhancingBio(false); }
    }, [appFunctions, editBio, setMessage]);

    const handleGetCloud = useCallback(async () => {
        setIsLoadingCloud(true);
        try { const result = await httpsCallable(appFunctions, 'getThematicCloud')({ targetUserId: profileUserId }); setThematicCloud(result.data); }
        catch (error) { setMessage(`Analysis failed: ${error.message}`); }
        finally { setIsLoadingCloud(false); }
    }, [appFunctions, profileUserId, setMessage]);

    const handleGetEchoesOfTomorrow = useCallback(async () => {
        setIsLoadingEchoes(true);
        try { const result = await httpsCallable(appFunctions, 'getEchoesOfTomorrow')(); setEchoesOfTomorrow(result.data.prompt); }
        catch (error) { setMessage(`Prompt generation failed: ${error.message}`); }
        finally { setIsLoadingEchoes(false); }
    }, [appFunctions, setMessage]);

    const handleAvatarChange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setIsUploading(true);
        try {
            const fileExtension = file.name.split('.').pop();
            const filePath = `avatars/${userId}/profile.${fileExtension}`;
            await uploadFile(file, filePath, () => { });
            const updateFunction = httpsCallable(appFunctions, 'updateProfilePicture');
            const result = await updateFunction({ filePath: filePath });
            const newUrl = result.data.newUrl;
            if (newUrl) {
                updateUserProfileInState(userId, { photoURL: newUrl });
            }
            setMessage("Profile picture updated successfully!");
        } catch (error) {
            setMessage(`Upload failed: ${error.message}`);
        } finally {
            setIsUploading(false);
        }
    };

    const handleSaveProfile = async () => {
        const interestsArray = editInterests.split(',').map(i => i.trim()).filter(Boolean);
        const newProfileData = { displayName: editDisplayName, bio: editBio, interests: interestsArray };
        try {
            await updateUserProfile(userId, newProfileData);
            updateUserProfileInState(userId, newProfileData);
            setMessage("Profile updated!");
            setIsEditing(false);
        }
        catch (error) { setMessage(`Failed to update profile: ${error.message}`); }
    };

    const handleCancelEdit = () => {
        setEditDisplayName(profileUser?.displayName || '');
        setEditBio(profileUser?.bio || '');
        setEditInterests(profileUser?.interests?.join(', ') || '');
        setIsEditing(false);
    };

    const handleBanUser = () => {
        showConfirmation({
            message: `Are you sure you want to permanently ban ${profileUser.displayName}? This action is irreversible.`,
            onConfirm: async () => {
                try {
                    // In a real app, you would prompt for a reason separately or use a more complex modal
                    const reason = "Banned by moderator action.";
                    await httpsCallable(appFunctions, 'banUser')({ targetUserId: profileUserId, reason: reason });
                    setMessage("User has been banned.");
                } catch (error) {
                    setMessage(`Failed to ban user: ${error.message}`);
                }
            }
        });
    };

    const filteredWhispers = useMemo(() =>
        userPublicWhispers.filter(e =>
            !e.isHidden && e.mediaType !== 'video' &&
            (e.content.toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
                (e.tags && e.tags.some(t => t.toLowerCase().includes(debouncedSearchTerm.toLowerCase()))))
        ), [userPublicWhispers, debouncedSearchTerm]);

    if (isLoading || !profileUser) return <LoadingSpinner message="Loading Profile..." />;
    const isPro = profileUser?.proStatus === 'active';

    return (
        <div className="p-4 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-4xl mx-auto text-white animate-fadeIn">
            {isModalOpen && <AIGeneratedContentModal title={aiModalContent.title} content={aiModalContent.content} onClose={() => setIsModalOpen(false)} LucideIcons={LucideIcons} />}
            {echoesOfTomorrow && <AIGeneratedContentModal title="An Echo from Tomorrow" content={echoesOfTomorrow} onClose={() => setEchoesOfTomorrow(null)} LucideIcons={LucideIcons} />}
            {showBioModal && <BioEnhancerModal suggestions={bioSuggestions} onClose={() => setShowBioModal(false)} onSelect={(bio) => { setEditBio(bio); setShowBioModal(false); }} LucideIcons={LucideIcons} />}

            <div className="profile-header">
                <div className="relative group">
                    <img src={profileUser.photoURL || "https://placehold.co/100x100/AEC6CF/FFFFFF?text=U"} alt={profileUser.displayName} className={`profile-avatar transition-opacity duration-300 ${isUploading ? 'opacity-50' : 'group-hover:opacity-70'}`} />
                    {isUploading && <div className="absolute inset-0 flex items-center justify-center"><div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-white"></div></div>}
                    {isSelf && !isUploading && (<>
                        <input type="file" ref={avatarInputRef} onChange={handleAvatarChange} className="hidden" accept="image/png, image/jpeg, image/gif" />
                        <button onClick={() => avatarInputRef.current.click()} className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" aria-label="Change picture"><LucideIcons.Camera size={32} /></button>
                    </>)}
                    {isPro && <div className="absolute -top-1 -right-1 p-1.5 bg-purple-600 rounded-full border-2 border-gray-900" title="Harmony Pro"><LucideIcons.Crown size={14} className="text-amber-300" /></div>}
                </div>
                {isEditing ? <input type="text" value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} className="bg-transparent border-b-2 border-blue-400 text-3xl font-bold text-center focus:outline-none" /> : <h2 className="text-3xl font-bold">{profileUser.displayName}</h2>}
                {profileUser.badges?.length > 0 && <div className="profile-badges">{profileUser.badges.map(badgeId => { const b = badgeConfig[badgeId]; if (!b) return null; const Icon = b.icon; return (<HoverTooltip key={badgeId} text={b.name}><div className="profile-badge"><Icon size={14} className={b.color} /></div></HoverTooltip>); })}</div>}
                {isEditing ? <div className="w-full max-w-md mt-2 relative"><textarea value={editBio} onChange={(e) => setEditBio(e.target.value)} className="bg-transparent border border-gray-600 rounded-md text-md w-full text-center focus:outline-none focus:ring-1 focus:ring-blue-400 p-2 pr-10" rows="2"></textarea><button onClick={() => showConfirmation({ message: `Enhance bio for ${TOKEN_COSTS.BIO_ENHANCER} Echoes?`, onConfirm: handleEnhanceBio })} disabled={isEnhancingBio} className="absolute top-1/2 right-2 -translate-y-1/2 text-teal-400 hover:text-teal-300 p-1 disabled:opacity-50" title="Enhance with AI">{isEnhancingBio ? <div className="action-spinner" /> : <LucideIcons.Sparkles size={20} />}</button></div> : <p className="text-md text-gray-300 mt-2 max-w-md">"{profileUser.bio || 'A seeker of harmony.'}"</p>}
                {isEditing && <div className="mt-2 w-full max-w-md"><label className="text-xs text-gray-400">Interests</label><input type="text" value={editInterests} onChange={(e) => setEditInterests(e.target.value)} className="bg-transparent border border-gray-600 rounded-md text-sm w-full text-center focus:outline-none focus:ring-1 focus:ring-blue-400 p-1" /></div>}

                <div className="profile-stats flex-wrap">
                    <div className="profile-stat-item"><span className="stat-value">{Math.round(profileUser.reputationScore) || 0}</span><span>Reputation</span></div>
                    <div className="profile-stat-item"><span className="stat-value">{Math.round(profileUser.influenceScore) || 0}</span><span>Influence</span></div>
                    <div className="profile-stat-item"><span className="stat-value">{userPublicWhispers.length}</span><span>Whispers</span></div>
                    <div className="profile-stat-item"><span className="stat-value">{profileUser.followerCount || 0}</span><span>Connections</span></div>
                </div>
            </div>

            <div className="flex flex-wrap justify-center gap-2 mb-6">
                {isSelf ? (isEditing ? (<>
                    <button onClick={handleSaveProfile} className="small-action-button bg-green-600 hover:bg-green-700">Save</button>
                    <button onClick={handleCancelEdit} className="small-action-button bg-gray-600 hover:bg-gray-700">Cancel</button>
                </>) : (<>
                    <button onClick={() => setIsEditing(true)} className="small-action-button bg-blue-600 hover:bg-blue-700">Edit Profile</button>
                    <button onClick={() => showConfirmation({ message: `Generate AI prompt for ${TOKEN_COSTS.ECHOES_OF_TOMORROW} Echoes?`, onConfirm: handleGetEchoesOfTomorrow })} disabled={isLoadingEchoes} className="small-action-button bg-indigo-500 hover:bg-indigo-600">
                        {isLoadingEchoes ? <div className="action-spinner" /> : <><LucideIcons.Wand2 size={14} className="mr-2" />AI Prompt</>}
                    </button>
                </>)) : (<>
                    <button onClick={() => onMessageUser(profileUser.id, profileUser.displayName)} className="small-action-button bg-blue-600 hover:bg-blue-700">Message</button>
                    <button onClick={() => onToggleConnection(profileUser.id, isConnected)} className={`small-action-button ${isConnected ? 'bg-gray-600' : 'bg-purple-600'}`}>{isConnected ? 'Disconnect' : 'Connect'}</button>
                    <button onClick={() => showConfirmation({ message: `Generate AI Snapshot for 30 Echoes?`, onConfirm: handleGetSnapshot })} disabled={isLoadingSnapshot} className="small-action-button bg-teal-500 text-white">{isLoadingSnapshot ? <div className="action-spinner" /> : <><LucideIcons.BrainCircuit size={14} className="mr-2" />Snapshot</>}</button>
                    {canModerate && <button onClick={handleBanUser} className="small-action-button bg-red-600 hover:bg-red-700"><LucideIcons.Ban size={14} className="mr-2" />Ban User</button>}
                </>)}
            </div>

            {personalitySnapshot && <PersonalitySnapshotDisplay snapshot={personalitySnapshot} LucideIcons={LucideIcons} />}
            {connectionCompass && <ConnectionCompassDisplay snapshot={connectionCompass} LucideIcons={LucideIcons} />}
            {thematicCloud && <ThematicCloudDisplay cloud={thematicCloud} LucideIcons={LucideIcons} />}

            <div className="profile-tabs">
                <button onClick={() => setActiveTab('whispers')} className={`profile-tab-button ${activeTab === 'whispers' ? 'active' : ''}`}>Whispers</button>
                <button onClick={() => setActiveTab('media')} className={`profile-tab-button ${activeTab === 'media' ? 'active' : ''}`}>Media</button>
                <button onClick={() => setActiveTab('nexuses')} className={`profile-tab-button ${activeTab === 'nexuses' ? 'active' : ''}`}>Nexuses</button>
            </div>

            <div>
                {activeTab === 'whispers' && (
                    <>
                        {isSelf && (
                            <div className="mb-6 max-w-lg mx-auto">
                                <input type="text" placeholder="Search your whispers..." className="shadow appearance-none border rounded-full w-full py-2 px-4 bg-gray-800 bg-opacity-50 text-white" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                            </div>
                        )}
                        {isSelf ? (
                            <MyWhispersTab whispers={filteredWhispers} loadingStates={loadingStates} currentUserProfile={currentUserProfile} onSpotlight={handleSetSpotlight} onAiAction={handleWhisperAiAction} onDelete={handleDeleteWhisper} showConfirmation={showConfirmation} />
                        ) : (
                            <ProfileWhispersTab whispers={userPublicWhispers.filter(w => !w.isHidden)} />
                        )}
                        {hasMoreWhispers && (
                            <button onClick={() => fetchWhispers(true, lastVisibleWhisper)} disabled={isLoadingMore} className="w-full mt-4 small-action-button bg-blue-600 justify-center py-2 text-white">
                                {isLoadingMore ? 'Loading More...' : 'Load More Whispers'}
                            </button>
                        )}
                    </>
                )}
                {activeTab === 'media' && <ProfileMediaTab whispers={userPublicWhispers} onDelete={handleDeleteWhisper} showConfirmation={showConfirmation} isSelf={isSelf} />}
                {activeTab === 'nexuses' && <ProfileNexusesTab nexuses={userNexuses} />}
            </div>
        </div>
    );
} function LeaderboardPage() {
    const { db, doc, getDoc, appId, LucideIcons, handleUserSelect, handlePageChange } = useAppContext();
    const [userLeaderboards, setUserLeaderboards] = useState(null);
    const [nexusLeaderboards, setNexusLeaderboards] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('reputation');
    const [activeNexusTab, setActiveNexusTab] = useState('level');

    useEffect(() => {
        const fetchLeaderboards = async () => {
            setIsLoading(true);
            try {
                const userLeaderboardRef = doc(db, `artifacts/${appId}/public/data/app_metadata/leaderboards`);
                const nexusLeaderboardRef = doc(db, `artifacts/${appId}/public/data/app_metadata/nexus_leaderboards`);

                const [userDocSnap, nexusDocSnap] = await Promise.all([
                    getDoc(userLeaderboardRef),
                    getDoc(nexusLeaderboardRef)
                ]);

                setUserLeaderboards(userDocSnap.exists() ? userDocSnap.data() : null);
                setNexusLeaderboards(nexusDocSnap.exists() ? nexusDocSnap.data() : null);

            } catch (error) {
                console.error("Error fetching leaderboards:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchLeaderboards();
    }, [db, doc, getDoc, appId]);

    const UserLeaderboardList = ({ users, unit }) => {
        if (!users || users.length === 0) {
            return <div className="text-center text-gray-400 italic py-8"><LucideIcons.Hourglass size={48} className="mx-auto mb-4" /><p>Rankings are being calculated. Check back soon!</p></div>;
        }
        return (
            <div className="space-y-2 animate-fadeIn">
                {users.map((user, index) => (
                    <div key={user.id} onClick={() => handleUserSelect(user.id)} className="bg-gray-800/70 p-3 rounded-lg flex items-center justify-between cursor-pointer hover:bg-gray-700/80">
                        <div className="flex items-center gap-4"><span className="font-bold text-lg text-gray-400 w-6 text-center">{index + 1}</span><img src={user.photoURL || "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U"} alt={user.displayName} className="w-10 h-10 rounded-full object-cover" /><p className="font-semibold text-white truncate">{user.displayName}</p></div>
                        <p className="font-bold text-lg text-yellow-300 flex items-center gap-2">{user.value} <span className="text-sm text-yellow-500">{unit}</span></p>
                    </div>
                ))}
            </div>
        );
    };

    const NexusLeaderboardList = ({ nexuses, unit }) => {
        if (!nexuses || nexuses.length === 0) {
            return <div className="text-center text-gray-400 italic py-8"><LucideIcons.Hourglass size={48} className="mx-auto mb-4" /><p>Nexus rankings are being calculated. Check back soon!</p></div>;
        }
        return (
            <div className="space-y-2 animate-fadeIn">
                {nexuses.map((nexus, index) => (
                    <div key={nexus.id} onClick={() => handlePageChange('nexus', { nexusId: nexus.id })} className="bg-gray-800/70 p-3 rounded-lg flex items-center justify-between cursor-pointer hover:bg-gray-700/80">
                        <div className="flex items-center gap-4"><span className="font-bold text-lg text-gray-400 w-6 text-center">{index + 1}</span><div className="w-10 h-10 rounded-md flex-shrink-0" style={{ backgroundColor: nexus.nexusColor }}><img src={nexus.coverImageURL} alt={nexus.name} className="w-full h-full object-cover rounded-md opacity-40" /></div><p className="font-semibold text-white truncate">{nexus.name}</p></div>
                        <p className="font-bold text-lg text-purple-300 flex items-center gap-2">{nexus.value} <span className="text-sm text-purple-500">{unit}</span></p>
                    </div>
                ))}
            </div>
        );
    };

    if (isLoading) {
        return <LoadingSpinner message="Aligning the Stars..." />;
    }

    return (
        <div className="p-4 sm:p-6 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-2xl mx-auto text-white">
            <h2 className="text-3xl font-bold text-center mb-6 text-blue-300 font-playfair">Community Leaders</h2>
            <div className="flex justify-center border-b border-gray-700 mb-6">
                <button onClick={() => setActiveTab('reputation')} className={`profile-tab-button ${activeTab === 'reputation' ? 'active' : ''}`}>Reputation</button>
                <button onClick={() => setActiveTab('earnings')} className={`profile-tab-button ${activeTab === 'earnings' ? 'active' : ''}`}>Earnings</button>
                <button onClick={() => setActiveTab('nexus')} className={`profile-tab-button ${activeTab === 'nexus' ? 'active' : ''}`}>Nexus</button>
            </div>

            {activeTab === 'reputation' && <UserLeaderboardList users={userLeaderboards?.reputation} unit="Rep" />}
            {activeTab === 'earnings' && <UserLeaderboardList users={userLeaderboards?.earnings} unit="Echoes" />}
            {activeTab === 'nexus' && (
                <div>
                    <div className="flex justify-center gap-2 mb-4">
                        <button onClick={() => setActiveNexusTab('level')} className={`small-action-button ${activeNexusTab === 'level' ? 'bg-purple-600' : 'bg-gray-600'}`}>By Level</button>
                        <button onClick={() => setActiveNexusTab('luminance')} className={`small-action-button ${activeNexusTab === 'luminance' ? 'bg-purple-600' : 'bg-gray-600'}`}>By Luminance</button>
                    </div>
                    {activeNexusTab === 'level' && <NexusLeaderboardList nexuses={nexusLeaderboards?.by_level} unit="Level" />}
                    {activeNexusTab === 'luminance' && <NexusLeaderboardList nexuses={nexusLeaderboards?.by_luminance_gained} unit="Gained" />}
                </div>
            )}
        </div>
    );
}

const HarmonyProModal = ({ onClose }) => {
    const { appFunctions, setMessage, LucideIcons, stripePromise } = useAppContext();
    const [isRedirecting, setIsRedirecting] = useState(false);

    const handleSubscribe = async () => {
        setIsRedirecting(true);
        const createSubscriptionSession = httpsCallable(appFunctions, 'createStripeSubscriptionSession');
        try {
            const result = await createSubscriptionSession();
            const { sessionId } = result.data;
            const stripe = await stripePromise;
            await stripe.redirectToCheckout({ sessionId });
        } catch (error) {
            console.error("Error redirecting to Stripe:", error);
            setMessage(`Could not initiate subscription: ${error.message}`);
            setIsRedirecting(false);
        }
    };

    return (
        <div className="modal-overlay">
            <div className="bg-gray-900/80 backdrop-blur-md p-6 rounded-lg shadow-glow max-w-md w-full text-white relative border border-purple-500/50 text-center">
                <h3 className="text-2xl font-bold mb-4 text-purple-300 font-playfair flex items-center justify-center"><LucideIcons.Crown size={24} className="mr-3 text-amber-300" /> Harmony Pro</h3>
                <p className="text-gray-300 mb-6">Elevate your experience and support the cosmos. Unlock these exclusive premium features.</p>
                <ul className="space-y-3 text-left mb-8 text-gray-200">
                    <li className="flex items-center"><LucideIcons.CheckCircle2 size={18} className="text-green-400 mr-3" /> <span className="font-bold text-yellow-400">500 Bonus Echoes</span> every month.</li>
                    <li className="flex items-center"><LucideIcons.CheckCircle2 size={18} className="text-green-400 mr-3" /> <span className="font-bold text-sky-400">50% Discount</span> on all AI analysis features.</li>
                    <li className="flex items-center"><LucideIcons.CheckCircle2 size={18} className="text-green-400 mr-3" /> Exclusive <span className="font-bold text-amber-300">"Pro" Profile & Post Badge</span>.</li>
                    <li className="flex items-center"><LucideIcons.CheckCircle2 size={18} className="text-green-400 mr-3" /> Special <span className="font-bold text-purple-400">visual flair</span> on all your comments.</li>
                    <li className="flex items-center"><LucideIcons.CheckCircle2 size={18} className="text-green-400 mr-3" /> Unlimited Aura Chamber Scans.</li>
                    <li className="flex items-center"><LucideIcons.CheckCircle2 size={18} className="text-green-400 mr-3" /> Access to deep-dive Mood Analysis Charts.</li>
                </ul>
                <button onClick={handleSubscribe} disabled={isRedirecting} className="w-full small-action-button bg-purple-600 hover:bg-purple-700 text-lg py-3">
                    {isRedirecting ? "Redirecting..." : "Go Pro - $4.99/month"}
                </button>
                <button onClick={onClose} className="absolute top-3 right-3 p-2 rounded-full bg-gray-700/50 hover:bg-gray-600/50 transition duration-300" aria-label="Close"><LucideIcons.X size={20} /></button>
            </div>
        </div>
    );
};

// In App.js, add this new custom hook.
const useIntersectionObserver = (options) => {
    const [entry, setEntry] = useState(null);
    const [node, setNode] = useState(null);

    const observer = useRef(null);

    useEffect(() => {
        if (observer.current) observer.current.disconnect();

        observer.current = new window.IntersectionObserver(([entry]) => setEntry(entry), options);

        const { current: currentObserver } = observer;
        if (node) currentObserver.observe(node);

        return () => currentObserver.disconnect();
    }, [node, options]);

    return [setNode, entry];
};

// In App.js, add this entire new component.
function MyMomentsPage() {
    const { appFunctions, setMessage, handleUserSelect, showConfirmation, userId, handlePageChange, LucideIcons } = useAppContext();
    const [moments, setMoments] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [commentingOn, setCommentingOn] = useState(null);
    const [currentReelIndex, setCurrentReelIndex] = useState(0);
    const viewerRef = useRef(null);
    // --- THIS IS THE FIX (Part 1): Add mute state management ---
    const [isMuted, setIsMuted] = useState(true);

    useEffect(() => {
        const fetchMyMoments = async () => {
            setIsLoading(true);
            const getMyMoments = httpsCallable(appFunctions, 'getMyMoments');
            try {
                const result = await getMyMoments();
                setMoments(result.data.moments || []);
            } catch (err) {
                setError("Could not load your Moments.");
                setMessage(`Failed to load your Moments: ${err.message}`);
            } finally {
                setIsLoading(false);
            }
        };
        fetchMyMoments();
    }, [appFunctions, setMessage]);

    const handleScroll = (e) => {
        const { scrollTop, clientHeight } = e.currentTarget;
        const newIndex = Math.round(scrollTop / clientHeight);
        if (newIndex !== currentReelIndex) {
            setCurrentReelIndex(newIndex);
        }
    };

    const handleLike = useCallback((momentId, authorId) => {
        setMoments(prev => prev.map(m => {
            if (m.id === momentId) {
                const hasLiked = m.likes?.includes(userId);
                return { ...m, likes: hasLiked ? m.likes.filter(id => id !== userId) : [...(m.likes || []), userId], likesCount: hasLiked ? (m.likesCount || 1) - 1 : (m.likesCount || 0) + 1 };
            }
            return m;
        }));
        const toggleReaction = httpsCallable(appFunctions, 'togglePostReaction');
        toggleReaction({ entryId: momentId, authorId, reactionType: 'like' }).catch(() => setMessage("Like failed to sync."));
    }, [appFunctions, setMessage, userId]);

    const handleAmplify = useCallback((momentId) => {
        showConfirmation({
            message: `Invest 10 Echoes to amplify this Moment?`,
            onConfirm: async () => {
                const amplifyWhisper = httpsCallable(appFunctions, 'amplifyWhisper');
                try {
                    await amplifyWhisper({ whisperId: momentId, amount: 10 });
                    setMessage(`Moment amplified!`);
                    setMoments(prev => prev.map(m => m.id === momentId ? { ...m, echoesInvested: (m.echoesInvested || 0) + 10 } : m));
                } catch (error) { setMessage(`Amplification failed: ${error.message}`); }
            }
        });
    }, [appFunctions, setMessage, showConfirmation]);

    const ReelCommentsModal = ({ moment, onClose }) => {
        const { LucideIcons, userId, onUserSelect } = useAppContext();
        return (
            <div className="comments-modal-overlay" onClick={onClose}>
                <div className="comments-modal-container" onClick={e => e.stopPropagation()}>
                    <div className="comments-modal-header">
                        <h3 className="text-lg font-bold text-white">Comments for {moment.authorName}'s Moment</h3>
                        <button onClick={onClose} className="absolute top-2 right-2 p-2 text-gray-400 hover:text-white"><LucideIcons.X size={24} /></button>
                    </div>
                    <div className="comments-modal-body">
                        <CommentSection entryId={moment.id} currentUserId={userId} onUserSelect={onUserSelect} />
                    </div>
                </div>
            </div>
        );
    };

    if (isLoading) return <LoadingSpinner message="Loading Your Moments..." />;
    if (error) return <div className="fixed inset-0 z-50 bg-black flex items-center justify-center text-red-400">{error}</div>;

    return (
        <>
            {commentingOn && <ReelCommentsModal moment={commentingOn} onClose={() => setCommentingOn(null)} />}
            <div ref={viewerRef} className="reels-viewer" onScroll={handleScroll}>
                {moments.length > 0 ? (
                    moments.map((moment, index) => (
                        <ReelItem
                            key={moment.id}
                            moment={moment}
                            isActive={index === currentReelIndex}
                            onLike={handleLike}
                            onComment={setCommentingOn}
                            onAmplify={handleAmplify}
                            onUserSelect={handleUserSelect}
                            // --- THIS IS THE FIX (Part 2): Pass the state and handler down ---
                            isMuted={isMuted}
                            onMuteToggle={() => setIsMuted(prev => !prev)}
                        />
                    ))
                ) : (
                    <div className="reel-item text-white text-center flex items-center justify-center">
                        <div className="p-8 bg-gray-800/50 rounded-lg max-w-sm">
                            <LucideIcons.VideoOff size={48} className="mx-auto mb-4 text-purple-400" />
                            <h3 className="text-xl font-bold">Your Stage is Awaiting</h3>
                            <p className="mt-2 mb-4 text-gray-300">You haven't created any Moments yet. Share a video to express yourself and connect with the community!</p>
                            <button onClick={() => handlePageChange('createMoment')} className="small-action-button bg-purple-600 hover:bg-purple-700 text-base px-6 py-3">
                                Create Your First Moment
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
// In App.js, REPLACE the existing ReelItem component.
const ReelItem = ({ moment, isActive, onLike, onComment, onAmplify, onUserSelect, isMuted, onMuteToggle }) => {
    const { LucideIcons, userId, userProfiles } = useAppContext();
    const [isPlaying, setIsPlaying] = useState(false);
    const [showPlaybackIcon, setShowPlaybackIcon] = useState(false);
    const playerRef = useRef(null);
    const oembedRef = useRef(null);
    const authorProfile = userProfiles.find(p => p.id === moment.authorId);

    useEffect(() => {
        setIsPlaying(isActive);
    }, [isActive]);

    // This effect ensures that when an oEmbed (like Instagram/TikTok) is used,
    // the Iframely script is triggered to render the content properly.
    useEffect(() => {
        if (isActive && moment.oembedHtml && oembedRef.current && window.iframely) {
            window.iframely.load(oembedRef.current);
        }
    }, [isActive, moment.oembedHtml]);


    const handleVideoClick = () => {
        setShowPlaybackIcon(true);
        setTimeout(() => setShowPlaybackIcon(false), 500);
        setIsPlaying(prev => !prev);
    };
    const renderPlayer = () => {
        const urlToPlay = moment.embedUrl || moment.mediaUrl;
        if (!urlToPlay) {
            return (
                <div className="w-full h-full flex flex-col items-center justify-center bg-black text-white text-center p-4">
                    <LucideIcons.VideoOff size={48} className="text-red-500 mb-4" />
                    <p className="font-bold">Media Not Available</p>
                </div>
            );
        }

        // Use a manually constructed iframe for specific embed URLs from Iframely
        if (moment.embedUrl) {
            // CRITICAL FIX: The 'mute' parameter MUST be tied to the isMuted state for autoplay to work.
            const separator = moment.embedUrl.includes('?') ? '&' : '?';
            const src = `${moment.embedUrl}${separator}autoplay=1&mute=${isMuted ? 1 : 0}`;
            return (
                <iframe
                    src={src}
                    className="react-player"
                    width="100%"
                    height="100%"
                    frameBorder="0"
                    allow="autoplay; fullscreen; picture-in-picture"
                    allowFullScreen
                    title={`Moment by ${moment.authorName}`}
                ></iframe>
            );
        }

        // Use the oEmbed HTML for platforms that require it (e.g., Instagram)
        if (moment.oembedHtml) {
            return (
                <div
                    ref={oembedRef}
                    className="oembed-container"
                    dangerouslySetInnerHTML={{ __html: moment.oembedHtml }}
                />
            );
        }


        return (
            <ReactPlayer
                ref={playerRef}
                url={urlToPlay}
                playing={isActive} // Only play if the reel is active
                loop={true}      // Always loop
                muted={isMuted}
                controls={false}
                width="100%"
                height="100%"
                className="react-player"
                playsinline={true}
            />
        );
    };


    return (
        <div className="reel-item" onClick={handleVideoClick}>
            <div className="reel-player-wrapper">
                {renderPlayer()}
            </div>
            <div className={`reel-playback-icon ${showPlaybackIcon ? 'visible' : ''}`}>
                {isPlaying ? <LucideIcons.Pause size={64} /> : <LucideIcons.Play size={64} />}
            </div>
            <div className="reel-overlay"></div>
            <div className="reel-ui-container">
                <div className="reel-details">
                    <div className="author-info" onClick={(e) => { e.stopPropagation(); onUserSelect(moment.authorId); }}>
                        <img src={moment.authorPhotoURL || "https://placehold.co/40x40/AEC6CF/FFFFFF?text=U"} alt={moment.authorName} className="w-10 h-10 rounded-full object-cover border-2 border-white" />
                        <span>{moment.authorName}</span>
                    </div>
                    {moment.content && <p className="caption">{moment.content}</p>}
                </div>
                <div className="reel-actions">
                    <button onClick={(e) => { e.stopPropagation(); onLike(moment.id, moment.authorId); }} className="reel-action-button">
                        <LucideIcons.Heart size={32} fill={moment.likes?.includes(userId) ? '#ef4444' : 'transparent'} color={moment.likes?.includes(userId) ? '#ef4444' : 'white'} />
                        <span className="count">{moment.likesCount || 0}</span>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onComment(moment); }} className="reel-action-button">
                        <LucideIcons.MessageCircle size={32} color="white" />
                        <span className="count">{moment.commentsCount || 0}</span>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onAmplify(moment.id); }} className="reel-action-button">
                        <LucideIcons.Flame size={32} color="#f59e0b" />
                        <span className="count">{moment.echoesInvested || 0}</span>
                    </button>
                </div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); onMuteToggle(); }} className="reel-mute-button">
                {isMuted ? <LucideIcons.VolumeX size={24} /> : <LucideIcons.Volume2 size={24} />}
            </button>
        </div>
    );
};
// In App.js, REPLACE the existing ReelsViewer component.
function ReelsViewer() {
    const { appFunctions, setMessage, handleUserSelect, showConfirmation, userId } = useAppContext();
    const [moments, setMoments] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastVisible, setLastVisible] = useState(null);
    const [hasMore, setHasMore] = useState(true);
    const [commentingOn, setCommentingOn] = useState(null);
    const [isMuted, setIsMuted] = useState(true); // Muted by default is best practice
    const viewerRef = useRef(null);

    // --- THIS IS THE FIX (Part 1) ---
    // State to track the index of the currently visible reel.
    const [currentReelIndex, setCurrentReelIndex] = useState(0);

    const fetchMoments = useCallback(async (startAfter = null) => {
        if (!hasMore && startAfter) return;
        const getMoments = httpsCallable(appFunctions, 'getMomentsFeed');
        try {
            const result = await getMoments({ lastVisible: startAfter });
            const newMoments = (result.data.moments || []).filter(m => m.mediaUrl && m.mediaUrl.startsWith('http'));

            setMoments(prev => startAfter ? [...prev, ...newMoments] : newMoments);
            setLastVisible(result.data.lastVisible);
            setHasMore(!!result.data.lastVisible);
        } catch (error) {
            setError("Could not load Moments.");
            setMessage(`Failed to load Moments: ${error.message}`);
        } finally {
            setIsLoading(false);
        }
    }, [appFunctions, hasMore, setMessage]);

    useEffect(() => {
        fetchMoments();
    }, [fetchMoments]);

    // --- THIS IS THE FIX (Part 2) ---
    // This scroll handler calculates which reel is in the viewport and updates the state.
    const handleScroll = (e) => {
        const { scrollTop, clientHeight } = e.currentTarget;
        const newIndex = Math.round(scrollTop / clientHeight);
        if (newIndex !== currentReelIndex) {
            setCurrentReelIndex(newIndex);
        }
        // Load more content when the user is 2 videos away from the end
        if (hasMore && newIndex >= moments.length - 2 && moments.length > 0) {
            fetchMoments(lastVisible);
        }
    };

    const handleLike = useCallback((momentId, authorId) => {
        setMoments(prev => prev.map(m => {
            if (m.id === momentId) {
                const hasLiked = m.likes?.includes(userId);
                return { ...m, likes: hasLiked ? m.likes.filter(id => id !== userId) : [...(m.likes || []), userId], likesCount: hasLiked ? (m.likesCount || 1) - 1 : (m.likesCount || 0) + 1 };
            }
            return m;
        }));
        const toggleReaction = httpsCallable(appFunctions, 'togglePostReaction');
        toggleReaction({ entryId: momentId, authorId, reactionType: 'like' }).catch(() => setMessage("Like failed to sync."));
    }, [appFunctions, setMessage, userId]);

    const handleAmplify = useCallback((momentId) => {
        showConfirmation({
            message: `Invest 10 Echoes to amplify this Moment?`,
            onConfirm: async () => {
                const amplifyWhisper = httpsCallable(appFunctions, 'amplifyWhisper');
                try {
                    await amplifyWhisper({ whisperId: momentId, amount: 10 });
                    setMessage(`Moment amplified!`);
                    setMoments(prev => prev.map(m => m.id === momentId ? { ...m, echoesInvested: (m.echoesInvested || 0) + 10 } : m));
                } catch (error) { setMessage(`Amplification failed: ${error.message}`); }
            }
        });
    }, [appFunctions, setMessage, showConfirmation]);

    const ReelCommentsModal = ({ moment, onClose }) => {
        const { LucideIcons, userId, onUserSelect } = useAppContext();
        return (
            <div className="comments-modal-overlay" onClick={onClose}>
                <div className="comments-modal-container" onClick={e => e.stopPropagation()}>
                    <div className="comments-modal-header">
                        <h3 className="text-lg font-bold text-white">Comments for {moment.authorName}'s Moment</h3>
                        <button onClick={onClose} className="absolute top-2 right-2 p-2 text-gray-400 hover:text-white"><LucideIcons.X size={24} /></button>
                    </div>
                    <div className="comments-modal-body">
                        <CommentSection entryId={moment.id} currentUserId={userId} onUserSelect={onUserSelect} />
                    </div>
                </div>
            </div>
        );
    };

    if (isLoading) return <LoadingSpinner message="Loading Moments..." />;
    if (error) return <div className="fixed inset-0 z-50 bg-black flex items-center justify-center text-red-400">{error}</div>;

    return (
        <>
            {commentingOn && <ReelCommentsModal moment={commentingOn} onClose={() => setCommentingOn(null)} />}
            <div ref={viewerRef} className="reels-viewer" onScroll={handleScroll}>
                {moments.map((moment, index) => (
                    <ReelItem
                        key={moment.id}
                        moment={moment}
                        // --- THIS IS THE FIX (Part 3) ---
                        // Pass the `isActive` prop to each item.
                        isActive={index === currentReelIndex}
                        onLike={handleLike}
                        onComment={setCommentingOn}
                        onAmplify={handleAmplify}
                        onUserSelect={handleUserSelect}
                        isMuted={isMuted}
                        onMuteToggle={() => setIsMuted(prev => !prev)}
                    />
                ))}
                {moments.length === 0 && (
                    <div className="reel-item text-white text-center">
                        <p>No Moments to show. <br /> Be the first to create one!</p>
                    </div>
                )}
            </div>
        </>
    );
}
function SettingsComponent() {
    const { userId, userProfiles, updateUserProfile, LucideIcons, setMessage, arrayUnion, arrayRemove, appFunctions, currentUserProfile, setShowProModal, db, appId, doc, setDoc, serverTimestamp } = useAppContext();
    const [aiWordCount, setAiWordCount] = useState(currentUserProfile?.aiMaxWordCount || 50);
    const [amplifyCost, setAmplifyCost] = useState(currentUserProfile?.amplifyCost || 10);
    const debouncedAiWordCount = useDebounce(aiWordCount, 500);
    const debouncedAmplifyCost = useDebounce(amplifyCost, 500);
    const [openAccordion, setOpenAccordion] = useState(null);
    const [notificationStatus, setNotificationStatus] = useState("default"); // Use string to avoid issues with Notification object

    useEffect(() => {
        // Check permission status once the component mounts
        if ('Notification' in window) {
            setNotificationStatus(Notification.permission);
        }
    }, []);

    const handleAccordionToggle = (title) => {
        setOpenAccordion(openAccordion === title ? null : title);
    };

    const handleEnableApilixNotifications = async () => {
        if (!('Notification' in window)) {
            setMessage("Push notifications are not supported by this browser.");
            return;
        }

        const permission = await Notification.requestPermission();
        setNotificationStatus(permission);

        if (permission === 'granted') {
            setMessage("Permission granted! Registering device with our notification service...");
            try {
                // ========================================================================
                // CRITICAL: REPLACE THIS PLACEHOLDER WITH YOUR ACTUAL APILIX SDK FUNCTION
                // ========================================================================
                const getApilixUserIdentityFromSDK = async () => {
                    console.warn("Using placeholder for getApilixUserIdentityFromSDK(). Replace with your actual Apilix SDK function to enable push notifications.");
                    // Example of what this might look like:
                    // if (window.Apilix && typeof window.Apilix.getIdentity === 'function') {
                    //    return await window.Apilix.getIdentity();
                    // }
                    return `mock_apilix_identity_${Date.now()}`;
                };
                // ========================================================================

                const userIdentity = await getApilixUserIdentityFromSDK();

                if (userIdentity) {
                    const identityRef = doc(db, `artifacts/${appId}/users/${userId}/private_tokens/apilix_user_identity`);
                    await setDoc(identityRef, { identity: userIdentity, timestamp: serverTimestamp() });
                    setMessage("Successfully registered for push notifications!");
                } else {
                    throw new Error("The notification service (Apilix) did not provide a user identity for this device.");
                }
            } catch (error) {
                console.error("Error registering with Apilix:", error);
                setMessage(`Could not register for push notifications: ${error.message}`);
            }
        } else {
            setMessage("Notification permission was not granted. You can change this in your browser or app settings.");
        }
    };

    useEffect(() => {
        if (currentUserProfile && debouncedAiWordCount !== (currentUserProfile.aiMaxWordCount || 50)) {
            updateUserProfile(userId, { aiMaxWordCount: debouncedAiWordCount });
        }
    }, [debouncedAiWordCount, userId, updateUserProfile, currentUserProfile]);

    useEffect(() => {
        if (currentUserProfile && debouncedAmplifyCost !== (currentUserProfile.amplifyCost || 10)) {
            updateUserProfile(userId, { amplifyCost: debouncedAmplifyCost });
        }
    }, [debouncedAmplifyCost, userId, updateUserProfile, currentUserProfile]);

    const tipsByCategory = useMemo(() => {
        const allTips = [
            { title: "AI-Generated Prompts", content: "Need inspiration? Use the 'Lightbulb' icon in 'New Entry' to get AI suggestions for your journal posts. It costs a few tokens, but can spark great ideas!", category: "Journaling AI" },
            { title: "Teaser for Anonymous Entries", content: "When Browse anonymous entries, you can pay a small fee and some tokens to get an AI-generated 'teaser'. This gives you a hint about the entry's content without revealing too much, helping you decide if you want to reveal the author.", category: "Anonymous Feed AI" },
            { title: "Find Similar Entries", content: "Curious if others share your thoughts? Use the 'Search' icon on anonymous entries to find other posts with similar themes, generated by AI. It's a great way to discover kindred spirits.", category: "Anonymous Feed AI" },
            { title: "Public Entry Summaries", content: "On anonymous entries, the 'Quote Bubble' icon provides a quick AI-generated summary. Get the gist of a long entry without reading it all!", category: "Anonymous Feed AI" },
            { title: "Public Entry Sentiment Analysis", content: "The 'Trending Up' icon on anonymous entries gives you an AI-powered sentiment analysis, telling you the overall mood of the post. Understand the vibe at a glance.", category: "Anonymous Feed AI" },
            { title: "Journal Summary (My Entries)", content: "In 'My Entries', use the 'Quote Bubble' icon to get a concise AI summary of your own posts. Great for quick reflection!", category: "Journaling AI" },
            { title: "Sentiment Analysis (My Entries)", content: "The 'Trending Up' icon on your own entries provides a detailed AI sentiment analysis, helping you understand your emotional patterns.", category: "Journaling AI" },
            { title: "Follow-Up Questions (My Entries)", content: "Want to dig deeper into your thoughts? The 'Lightbulb' icon on your entries can generate an AI-powered follow-up question to encourage further self-reflection.", category: "Journaling AI" },
            { title: "Bio Summary (User Profiles)", content: "When viewing other users' profiles, use the 'Quote Bubble' to get a quick AI summary of their bio. Learn about them faster!", category: "Profile AI" },
            { title: "Interest Analysis (User Profiles)", content: "The 'Trending Up' icon on user profiles gives you an AI analysis of their interests, offering insights into their personality and lifestyle.", category: "Profile AI" },
            { title: "Conversation Starters (User Profiles)", content: "Stuck on what to say? The 'Message Plus' icon on user profiles generates AI-powered conversation starters based on their profile, making it easier to connect.", category: "Profile AI" },
            { title: "Mood Insight", content: "The 'Mood Insight' button (smiley face icon) on the main screen provides an AI-generated summary of your recent journal entries' overall emotional state. It's like a personal emotional check-in!", category: "Journaling AI" },
            { title: "Earn Tokens", content: "Engage with the community to earn AI tokens! You get tokens for posting entries, and for liking/disliking and commenting on anonymous entries. Don't forget your daily bonus!", category: "Token System" },
            { title: "Spotlight Your Entries", content: "If you accumulate 1000 engagement points, you can use them to 'spotlight' one of your anonymous entries, making it more visible to others in the feed!", category: "Engagement" },
            { title: "Connect with Others", content: "Use the 'Connect' button on user profiles to follow other users. Their anonymous entries will then appear in your 'Connected Whispers' feed.", category: "Social Features" },
            { title: "Private Messaging", content: "Found someone interesting? Send them a private message from their profile or the 'Users' list to start a one-on-one conversation.", category: "Social Features" },
        ];

        return allTips.reduce((acc, tip) => {
            acc[tip.category] = acc[tip.category] || [];
            acc[tip.category].push(tip);
            return acc;
        }, {});
    }, []);

    const handleToggleAITips = useCallback(async () => {
        if (!userId) { setMessage("Please sign in to save settings."); return; }
        try {
            const currentShowTips = currentUserProfile?.showAITipsOnStartup ?? true;
            await updateUserProfile(userId, { showAITipsOnStartup: !currentShowTips });
            setMessage(`AI Tips on Startup: ${!currentShowTips ? 'Enabled' : 'Disabled'}`);
        } catch (e) {
            console.error("Error toggling AI tips:", e);
            setMessage(`Failed to update setting: ${e.message}`);
        }
    }, [userId, currentUserProfile, updateUserProfile, setMessage]);

    const handleToggleNotification = useCallback(async (type) => {
        if (!userId) { setMessage("Please sign in to save settings."); return; }
        try {
            const currentSettings = currentUserProfile?.notificationSettings || {};
            const newValue = !(currentSettings[type] ?? true);
            await updateUserProfile(userId, {
                [`notificationSettings.${type}`]: newValue
            });
            setMessage(`Notifications for ${type} ${newValue ? 'enabled' : 'disabled'}.`);
        } catch (e) {
            console.error(`Error toggling ${type} notifications:`, e);
            setMessage(`Failed to update notification setting: ${e.message}`);
        }
    }, [userId, currentUserProfile, updateUserProfile, setMessage]);

    const handleBlockUser = useCallback(async (targetUserId) => {
        if (!userId) { setMessage("Please sign in to manage blocked users."); return; }
        if (!targetUserId || targetUserId === userId) { setMessage("Invalid user to block."); return; }

        try {
            await updateUserProfile(userId, { blockedUsers: arrayUnion(targetUserId) });
            setMessage(`User blocked.`);
        } catch (e) {
            console.error("Error blocking user:", e);
            setMessage(`Failed to block user: ${e.message}`);
        }
    }, [userId, updateUserProfile, setMessage, arrayUnion]);

    const handleUnblockUser = useCallback(async (targetUserId) => {
        if (!userId) { setMessage("Please sign in to manage blocked users."); return; }
        try {
            await updateUserProfile(userId, { blockedUsers: arrayRemove(targetUserId) });
            setMessage(`User unblocked.`);
        } catch (e) {
            console.error("Error unblocking user:", e);
            setMessage(`Failed to unblock user: ${e.message}`);
        }
    }, [userId, updateUserProfile, setMessage, arrayRemove]);

    const handleManageSubscription = async () => {
        const manageSubscription = httpsCallable(appFunctions, 'manageStripeSubscription');
        try {
            const result = await manageSubscription();
            window.location.href = result.data.url;
        } catch (error) {
            setMessage(`Could not open subscription management: ${error.message}`);
        }
    };

    if (!currentUserProfile) {
        return <LoadingSpinner message="Loading Settings..." />;
    }

    const isPro = currentUserProfile.proStatus === 'active';

    return (
        <div className="p-6 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-2xl mx-auto text-white">
            <h2 className="text-3xl font-bold text-center mb-6 text-blue-300 font-playfair">Settings</h2>

            <div className="mb-8 p-4 border border-purple-400/30 bg-purple-900/20 rounded-lg">
                <h3 className="text-xl font-bold mb-4 text-purple-200">Subscription Status</h3>
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-lg font-semibold">{isPro ? "Harmony Pro Active" : "Standard Member"}</p>
                        {isPro && currentUserProfile.proTierExpires && <p className="text-xs text-gray-400">Renews on: {currentUserProfile.proTierExpires.toDate().toLocaleDateString()}</p>}
                    </div>
                    {isPro ? (
                        <button onClick={handleManageSubscription} className="small-action-button bg-gray-600 hover:bg-gray-700">Manage Subscription</button>
                    ) : (
                        <button onClick={() => setShowProModal(true)} className="small-action-button bg-purple-600 hover:bg-purple-700">Upgrade to Pro</button>
                    )}
                </div>
            </div>

            <div className="mb-8 p-4 border border-purple-400/30 bg-purple-900/20 rounded-lg">
                <h3 className="text-xl font-bold mb-4 text-purple-200">Economic & AI Settings</h3>
                <div className="flex flex-col space-y-6">
                    <div>
                        <label htmlFor="aiWordCount" className="text-lg text-gray-100 mb-2">Max AI Response Length</label>
                        <div className="flex items-center gap-4">
                            <input type="range" id="aiWordCount" min="20" max="100" step="5" value={aiWordCount} onChange={(e) => setAiWordCount(Number(e.target.value))} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                            <span className="font-bold text-purple-300 w-16 text-center">{aiWordCount} words</span>
                        </div>
                        <p className="text-xs text-gray-400 mt-2">Set a limit for AI-generated content. Shorter responses can reduce Echo costs and return faster.</p>
                    </div>
                    <div>
                        <label htmlFor="amplifyCost" className="text-lg text-gray-100 mb-2">Default Amplify Investment</label>
                        <div className="flex items-center gap-4">
                            <input type="range" id="amplifyCost" min="10" max="100" step="5" value={amplifyCost} onChange={(e) => setAmplifyCost(Number(e.target.value))} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-yellow-500" />
                            <span className="font-bold text-yellow-300 w-16 text-center flex items-center justify-center"><LucideIcons.Flame size={12} className="mr-1" />{amplifyCost}</span>
                        </div>
                        <p className="text-xs text-gray-400 mt-2">Choose the default amount of Echoes you wish to invest when amplifying a whisper.</p>
                    </div>
                </div>
            </div>

            <div className="mb-6">
                <h3 className="text-xl font-bold mb-4 text-blue-200">General Settings</h3>
                <div className="flex items-center justify-between mb-4 p-3 bg-gray-800/50 rounded-lg">
                    <label htmlFor="showAITips" className="text-lg text-gray-100 cursor-pointer">Show AI Tips on Startup</label>
                    <input type="checkbox" id="showAITips" checked={currentUserProfile.showAITipsOnStartup ?? true} onChange={handleToggleAITips} className="h-6 w-6 text-blue-600 rounded focus:ring-blue-500 bg-gray-700 border-gray-600" />
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg">
                    <label className="text-lg text-gray-100">Push Notifications</label>
                    <button onClick={handleEnableApilixNotifications} className={`small-action-button text-white ${notificationStatus === 'granted' ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-700'}`} disabled={notificationStatus === 'granted'}>
                        {notificationStatus === 'granted' ? 'Enabled' : 'Enable'}
                    </button>
                </div>
            </div>

            <div className="mt-8 pt-6 border-t border-gray-700">
                <h3 className="text-xl font-bold mb-4 text-blue-200">Notification Settings</h3>
                <div className="space-y-3">
                    {['likes', 'comments', 'messages', 'connects'].map(type => (
                        <div key={type} className="flex items-center justify-between p-3 bg-gray-800/50 rounded-lg">
                            <label htmlFor={`notify${type}`} className="text-lg text-gray-100 cursor-pointer capitalize">{type}</label>
                            <input type="checkbox" id={`notify${type}`} checked={currentUserProfile.notificationSettings?.[type] ?? true} onChange={() => handleToggleNotification(type)} className="h-6 w-6 text-blue-600 rounded focus:ring-blue-500 bg-gray-700 border-gray-600" />
                        </div>
                    ))}
                </div>
            </div>

            <div className="mt-8 pt-6 border-t border-gray-700">
                <h3 className="text-xl font-bold mb-4 text-blue-200">Privacy Settings</h3>
                <div className="space-y-3">
                    <p className="text-lg text-gray-100">Blocked Users:</p>
                    {currentUserProfile.blockedUsers?.length > 0 ? (
                        <ul className="space-y-2">
                            {currentUserProfile.blockedUsers.map(blockedId => (
                                <li key={blockedId} className="flex justify-between items-center bg-gray-700 p-3 rounded-md">
                                    <span className="font-mono text-sm">{userProfiles.find(p => p.id === blockedId)?.displayName || blockedId}</span>
                                    <button onClick={() => handleUnblockUser(blockedId)} className="px-3 py-1 bg-green-600 text-white rounded-md hover:bg-green-700 transition duration-300 text-sm">Unblock</button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-gray-400 italic">No users currently blocked.</p>
                    )}
                    <div className="flex gap-2 mt-4">
                        <input type="text" id="blockUserId" placeholder="Enter User ID to block" className="flex-1 shadow appearance-none border rounded-full py-2 px-3 bg-gray-800 bg-opacity-50 text-white leading-tight focus:outline-none focus:ring-1 focus:ring-blue-300" onKeyPress={(e) => { if (e.key === 'Enter') { handleBlockUser(e.target.value); e.target.value = ''; } }} />
                        <button onClick={() => { const input = document.getElementById('blockUserId'); handleBlockUser(input.value); input.value = ''; }} className="px-4 py-2 bg-red-500 text-white rounded-full hover:bg-red-600 transition duration-300">Block</button>
                    </div>
                </div>
            </div>

            <div className="mt-8">
                <h3 className="text-xl font-bold mb-4 text-blue-200">All Tips & Features</h3>
                <div className="space-y-2">
                    {Object.entries(tipsByCategory).map(([category, tips]) => (
                        <AccordionItem
                            key={category}
                            title={category}
                            isOpen={openAccordion === category}
                            onToggle={() => handleAccordionToggle(category)}
                            LucideIcons={LucideIcons}
                        >
                            <div className="space-y-3">
                                {tips.map((tip, index) => (
                                    <div key={index} className="bg-gray-800 p-3 rounded-lg">
                                        <h4 className="font-semibold text-md text-gray-100 mb-1">{tip.title}</h4>
                                        <p className="text-sm text-gray-300">{tip.content}</p>
                                    </div>
                                ))}
                            </div>
                        </AccordionItem>
                    ))}
                </div>
            </div>
        </div>
    );
}
function JournalEntryForm() {
    const { userId, uploadFile, LucideIcons, appFunctions, setMessage, showConfirmation, db, collection, query, where, onSnapshot, appId, handlePageChange } = useAppContext();
    const [content, setContent] = useState('');
    const [tags, setTags] = useState('');
    const [mediaFile, setMediaFile] = useState(null);
    const [mediaPreview, setMediaPreview] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const mediaInputRef = useRef(null);
    const [isAnonymous, setIsAnonymous] = useState(true);
    const [postTarget, setPostTarget] = useState('public');
    const [myNexuses, setMyNexuses] = useState([]);
    const [isLoadingNexuses, setIsLoadingNexuses] = useState(true);

    const [vibe, setVibe] = useState(null);
    const [toneSuggestions, setToneSuggestions] = useState([]);
    const [showToneModal, setShowToneModal] = useState(false);
    const [loadingStates, setLoadingStates] = useState({
        tone: false,
        tags: false,
        vibe: false,
    });

    useEffect(() => {
        if (!userId) return;
        const q = query(collection(db, `artifacts/${appId}/public/data/nexuses`), where('memberIds', 'array-contains', userId));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setMyNexuses(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
            setIsLoadingNexuses(false);
        });
        return () => unsubscribe();
    }, [userId, db, collection, onSnapshot, query, where, appId]);

    const handleAiTool = useCallback(async (tool) => {
        if (!content.trim()) {
            setMessage("Please write something first to give the AI context.");
            return;
        }
        showConfirmation({
            message: `Use this AI tool for 5 Echoes?`,
            onConfirm: async () => {
                setLoadingStates(prev => ({ ...prev, [tool]: true }));
                const invokeAiHelper = httpsCallable(appFunctions, 'invokeWhisperAiHelper');
                try {
                    const result = await invokeAiHelper({ text: content, tool });
                    if (result.data.success) {
                        if (tool === 'amplify_tone') {
                            setToneSuggestions(result.data.suggestions);
                            setShowToneModal(true);
                        } else if (tool === 'suggest_tags') {
                            setTags(result.data.tags.join(', '));
                        } else if (tool === 'vibe_check') {
                            setVibe(result.data.vibe);
                        }
                    }
                } catch (error) {
                    console.error(`Error with AI tool '${tool}':`, error);
                    setMessage(`AI tool failed: ${error.message}`);
                } finally {
                    setLoadingStates(prev => ({ ...prev, [tool]: false }));
                }
            }
        });
    }, [content, appFunctions, setMessage, showConfirmation]);

    const handleSubmit = useCallback(async (e) => {
        e.preventDefault();
        if (!content.trim() && !mediaFile) {
            setMessage("A whisper must have content or media.");
            return;
        }
        setIsSubmitting(true);

        try {
            let mediaUrl = '', mediaPath = '';
            if (mediaFile) {
                const fileExtension = mediaFile.name.split('.').pop();
                mediaPath = `entries/${userId}/${Date.now()}.${fileExtension}`;
                mediaUrl = await uploadFile(mediaFile, mediaPath, setUploadProgress);
            }

            const tagsArray = tags.split(',').map(t => t.trim()).filter(Boolean);
            const payload = {
                content: content.trim(),
                tags: tagsArray,
                mediaUrl,
                mediaPath,
                isAnonymous,
                vibe,
            };

            if (postTarget === 'public') {
                const createWhisper = httpsCallable(appFunctions, 'createWhisper');
                const result = await createWhisper(payload);
                setMessage(`Whisper posted publicly! You earned ${result.data.reward} Echoes.`);
            } else {
                const postToNexus = httpsCallable(appFunctions, 'postToNexus');
                await postToNexus({ ...payload, nexusId: postTarget });
                setMessage(`Whisper posted to your Nexus!`);
                handlePageChange('nexus', { nexusId: postTarget });
            }

            setContent(''); setTags(''); setMediaFile(null); setMediaPreview('');
            if (mediaInputRef.current) mediaInputRef.current.value = "";
            setIsAnonymous(true); setPostTarget('public'); setVibe(null);

        } catch (error) {
            console.error("Error creating post:", error);
            setMessage(`Failed to post: ${error.message}`);
        } finally {
            setIsSubmitting(false);
        }
    }, [content, tags, mediaFile, userId, isAnonymous, appFunctions, uploadFile, setMessage, postTarget, handlePageChange, vibe]);

    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (file) {
            // --- THIS IS THE FIX: Prevent video uploads from this form ---
            if (file.type.startsWith('video/')) {
                setMessage("Videos must be uploaded as a 'Moment'. Please use the 'New Moment' page.");
                return;
            }
            setMediaFile(file);
            setMediaPreview(URL.createObjectURL(file));
        }
    };

    const ToneModal = ({ suggestions, onSelect, onClose }) => (
        <div className="tone-modal-overlay">
            <div className="tone-modal-content">
                <h3 className="text-xl font-bold text-center mb-4 text-indigo-300 font-playfair">Amplify Your Tone</h3>
                <div className="space-y-3">
                    {suggestions.map((suggestion, index) => (
                        <button key={index} onClick={() => onSelect(suggestion)} className="tone-suggestion-item">
                            <p className="italic">"{suggestion}"</p>
                        </button>
                    ))}
                </div>
                <button onClick={onClose} className="w-full mt-4 px-4 py-2 bg-gray-600 text-white font-bold rounded-full hover:bg-gray-700">Cancel</button>
            </div>
        </div>
    );

    return (
        <>
            {showToneModal && (
                <ToneModal
                    suggestions={toneSuggestions}
                    onSelect={(suggestion) => {
                        setContent(suggestion);
                        setShowToneModal(false);
                    }}
                    onClose={() => setShowToneModal(false)}
                />
            )}
            <div className="whisper-forge-container">
                <h2 className="text-3xl font-bold text-center mb-6 text-blue-300 font-playfair">The Whisper Forge</h2>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <textarea
                        id="journalContent"
                        className="forge-textarea w-full p-4 rounded-lg resize-y"
                        placeholder="Forge your thoughts in the cosmos..."
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                    />
                    <div className="forge-controls">
                        <HoverTooltip text="Amplify Tone (5 Echoes)"><button type="button" onClick={() => handleAiTool('amplify_tone')} disabled={loadingStates.tone || !content.trim()} className="forge-ai-button">{loadingStates.tone ? <div className="ai-button-spinner" /> : <LucideIcons.Wand2 size={20} />}</button></HoverTooltip>
                        <HoverTooltip text="Suggest Tags (5 Echoes)"><button type="button" onClick={() => handleAiTool('suggest_tags')} disabled={loadingStates.tags || !content.trim()} className="forge-ai-button">{loadingStates.tags ? <div className="ai-button-spinner" /> : <LucideIcons.Tags size={20} />}</button></HoverTooltip>
                        <HoverTooltip text="Vibe Check (5 Echoes)"><button type="button" onClick={() => handleAiTool('vibe_check')} disabled={loadingStates.vibe || !content.trim()} className="forge-ai-button">{loadingStates.vibe ? <div className="ai-button-spinner" /> : <LucideIcons.Smile size={20} />}</button></HoverTooltip>
                    </div>
                    {vibe && <p className="vibe-display">Vibe: {vibe}</p>}
                    <input type="text" id="journalTags" className="w-full py-2 px-4 bg-gray-800 text-white rounded-full border border-gray-600 focus:ring-2 focus:ring-indigo-500 focus:outline-none" placeholder="Add tags, separated by commas..." value={tags} onChange={(e) => setTags(e.target.value)} />
                    {mediaPreview && (
                        <div className="my-4 relative w-fit mx-auto">
                            <UniversalMediaRenderer entry={{ mediaUrl: mediaPreview }} isClickable={false} />
                            <button type="button" onClick={() => { setMediaFile(null); setMediaPreview(''); if (mediaInputRef.current) mediaInputRef.current.value = ""; }} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 hover:bg-red-600" aria-label="Remove media">
                                <LucideIcons.X size={14} />
                            </button>
                        </div>
                    )}
                    {isSubmitting && uploadProgress > 0 && uploadProgress < 100 && <progress value={uploadProgress} max="100" className="w-full my-2 accent-indigo-500" />}
                    <div className="forge-options flex flex-col sm:flex-row items-center justify-between gap-4 p-3 bg-black/20 rounded-lg">
                        <select id="postTarget" value={postTarget} onChange={(e) => setPostTarget(e.target.value)} className="w-full sm:w-auto bg-gray-800 text-white py-2 px-3 border border-gray-600 rounded-md focus:outline-none" disabled={isLoadingNexuses}>
                            <option value="public">Post to Public Feed</option>
                            {myNexuses.map(nexus => <option key={nexus.id} value={nexus.id}>Post to {nexus.name}</option>)}
                        </select>
                        <div className="flex items-center gap-3">
                            <label htmlFor="isAnonymous" className="text-gray-300 font-semibold cursor-pointer">Post Anonymously</label>
                            <label className="forge-switch">
                                <input type="checkbox" id="isAnonymous" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} />
                                <span className="forge-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div className="flex items-center justify-between mt-4">
                        <HoverTooltip text="Attach Media"><button type="button" onClick={() => mediaInputRef.current.click()} className="ai-icon-button text-gray-400 hover:text-white"><LucideIcons.Paperclip size={22} /></button></HoverTooltip>
                        <input type="file" ref={mediaInputRef} onChange={handleFileSelect} className="hidden" accept="image/*" />
                        <button type="submit" disabled={isSubmitting} className="px-8 py-3 bg-indigo-600 text-white font-bold rounded-full hover:bg-indigo-700 transition duration-300 disabled:opacity-50 flex items-center gap-2">
                            {isSubmitting ? <div className="action-spinner" /> : <LucideIcons.Send size={18} />}
                            {isSubmitting ? 'Posting...' : 'Post Whisper'}
                        </button>
                    </div>
                </form>
            </div>
        </>
    );
}


// In App.js, REPLACE the existing NotificationCard component with this new version.

const NotificationCard = ({ notification, onNavigate }) => {
    const { LucideIcons } = useAppContext();

    // --- THIS IS THE FIX: Logic to handle both normal and aggregated notifications ---
    const isAggregated = notification.type?.startsWith('AGGREGATED_');
    const baseType = isAggregated ? notification.type.replace('AGGREGATED_', '') : notification.type;

    const notificationConfig = {
        'DEFAULT': { icon: LucideIcons.Bell, color: 'text-gray-400' },
        'MESSAGE': { icon: LucideIcons.Mail, color: 'text-blue-400' },
        'COMMENT': { icon: LucideIcons.MessageCircle, color: 'text-green-400' },
        'GIFT': { icon: LucideIcons.Gift, color: 'text-yellow-400' },
        'LIKE': { icon: LucideIcons.Heart, color: 'text-pink-400' },
        'CONNECTION': { icon: LucideIcons.UserPlus, color: 'text-teal-400' },
        'AMPLIFY': { icon: LucideIcons.Flame, color: 'text-yellow-400' },
        'ECHO': { icon: LucideIcons.MessageSquareReply, color: 'text-cyan-400' },
        'QUEST_COMPLETE': { icon: LucideIcons.Award, color: 'text-purple-400' },
        'SEAL_REVEALED': { icon: LucideIcons.Unlock, color: 'text-indigo-400' },
        'CONSTELLATION_GROWTH': { icon: LucideIcons.Sparkles, color: 'text-purple-300' },
        // --- ADD THESE NEW TYPES ---
        'NEXUS_LEVEL_UP': { icon: LucideIcons.ArrowUpCircle, color: 'text-yellow-400' },
        'NEXUS_ROLE_CHANGE': { icon: LucideIcons.ShieldCheck, color: 'text-sky-400' },
        'NEXUS_KICK': { icon: LucideIcons.UserX, color: 'text-red-400' },
        'NEXUS_MENTION': { icon: LucideIcons.AtSign, color: 'text-green-400' },
    };

    const config = notificationConfig[baseType] || notificationConfig['DEFAULT'];
    const Icon = config.icon;

    return (
        <div
            onClick={() => onNavigate(notification)}
            className={`p-4 rounded-lg flex items-start space-x-4 transition-all duration-300 cursor-pointer ${notification.read ? 'bg-gray-800/50 hover:bg-gray-700/50' : 'bg-blue-900/40 hover:bg-blue-900/60 border border-blue-500/50'}`}
        >
            <div className={`flex-shrink-0 mt-1 relative ${config.color}`}>
                <Icon size={24} />
                {isAggregated && (
                    <span className="absolute -top-1 -right-2 bg-purple-500 text-white text-[10px] font-bold rounded-full h-4 w-4 flex items-center justify-center">
                        {notification.count}
                    </span>
                )}
            </div>
            <div className="flex-grow">
                <p className="text-gray-200">
                    <span className="font-bold">{notification.fromUserName || 'System'}</span> {notification.message}
                </p>
                {notification.reward > 0 && (
                    <p className="text-xs font-bold text-yellow-400 mt-1 flex items-center">
                        + {notification.reward} <LucideIcons.Gem size={12} className="ml-1.5" />
                    </p>
                )}
                <p className="text-xs text-gray-500 mt-2">
                    {notification.timestamp?.toDate ? notification.timestamp.toDate().toLocaleString() : 'Just now'}
                </p>
            </div>
            {!notification.read && (
                <div className="flex-shrink-0 self-center w-2.5 h-2.5 bg-blue-400 rounded-full animate-pulse"></div>
            )}
        </div>
    );
};


function NotificationsComponent() {
    const { userId, db, collection, query, orderBy, onSnapshot, updateDoc, doc, setMessage, appId, limit, handlePageChange, handleUserSelect, setEntryToScrollTo } = useAppContext();
    const [notifications, setNotifications] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!userId || !db) {
            setIsLoading(false);
            return;
        }
        const q = query(collection(db, `artifacts/${appId}/users/${userId}/notifications`), orderBy("timestamp", "desc"), limit(50));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            setNotifications(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
            setIsLoading(false);
        }, (e) => {
            console.error("Error listening to notifications:", e);
            setMessage(`Error loading notifications: ${e.message}`);
            setIsLoading(false);
        });
        return () => unsubscribe();
    }, [userId, db, collection, limit, onSnapshot, orderBy, query, appId, setMessage]);

    // In App.js, inside the NotificationsComponent...
    const handleNavigate = useCallback(async (notification) => {
        if (!notification.read) {
            try {
                await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/notifications`, notification.id), { read: true });
            } catch (e) { console.error("Error marking notification as read:", e); }
        }

        const nav = notification.navigation;
        if (nav && nav.page) {
            handlePageChange(nav.page, nav.params || {});
            return;
        }

        // Fallback logic for older or different notification types
        switch (notification.type) {
            case 'MESSAGE':
                handlePageChange('messages', { chatPartnerId: notification.chatPartnerId });
                break;
            case 'NEXUS_MENTION':
                if (notification.nexusId) {
                    handlePageChange('nexus', { nexusId: notification.nexusId });
                }
                break;
            case 'COMMENT':
            case 'AMPLIFY':
            case 'ECHO':
            case 'SEAL_REVEALED':
            case 'CONSTELLATION_GROWTH':
                if (notification.entryId) {
                    setEntryToScrollTo(notification.entryId);
                    handlePageChange('anonymousFeed');
                }
                break;
            case 'CONNECTION':
                if (notification.fromUserId) {
                    handleUserSelect(notification.fromUserId);
                }
                break;
            case 'QUEST_COMPLETE':
                handlePageChange('walletHub', { tab: 'quests' });
                break;
            // --- ADD THESE NEW CASES ---
            case 'NEXUS_LEVEL_UP':
            case 'NEXUS_ROLE_CHANGE':
                if (notification.nexusId) {
                    handlePageChange('nexus', { nexusId: notification.nexusId });
                }
                break;
            // --- END OF NEW CASES ---
            default:
                // A safe default action
                handlePageChange('anonymousFeed');
                break;
        }
    }, [userId, doc, updateDoc, db, appId, handlePageChange, handleUserSelect, setEntryToScrollTo]);

    if (isLoading) {
        return <LoadingSpinner message="Loading Notifications..." />;
    }

    return (
        <div className="p-6 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-2xl mx-auto text-white">
            <h2 className="text-3xl font-bold text-center mb-6 text-blue-300 font-playfair">Notifications</h2>
            {notifications.length === 0 ? (
                <p className="text-center text-gray-400 text-lg italic">You have no new notifications.</p>
            ) : (
                <div className="space-y-3">
                    {notifications.map(note => (
                        <NotificationCard
                            key={note.id}
                            notification={note}
                            onNavigate={handleNavigate}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// In App.js, add this entire new component.
function NexusFinder() {
    const { appFunctions, setMessage, showConfirmation, LucideIcons } = useAppContext();
    const [recommendations, setRecommendations] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');

    const handleFind = () => {
        setError('');
        setRecommendations([]);
        showConfirmation({
            message: "Use the AI Matchmaker to find your ideal communities? This costs 50 Echoes.",
            onConfirm: async () => {
                setIsLoading(true);
                const getNexusRecommendations = httpsCallable(appFunctions, 'getNexusRecommendations');
                try {
                    const result = await getNexusRecommendations();
                    setRecommendations(result.data.recommendations || []);
                } catch (err) {
                    console.error("Error getting recommendations:", err);
                    setError(err.message);
                } finally {
                    setIsLoading(false);
                }
            }
        });
    };

    return (
        <div className="p-4 bg-gradient-to-br from-purple-900/50 to-blue-900/50 rounded-lg shadow-lg mb-6 text-center border border-purple-500/50">
            <h3 className="text-xl font-bold text-white font-playfair mb-2">Find Your Community</h3>
            <p className="text-gray-300 mb-4">Let our AI analyze your whispers to recommend the perfect Nexus for you.</p>
            <button onClick={handleFind} disabled={isLoading} className="small-action-button bg-purple-600 hover:bg-purple-700 text-lg py-3 px-6 disabled:opacity-50">
                {isLoading ? <div className="action-spinner" /> : <><LucideIcons.BrainCircuit size={18} className="mr-2" /> Find My Nexus</>}
            </button>

            {error && <p className="text-red-400 mt-4">{error}</p>}

            {recommendations.length > 0 && (
                <div className="mt-6 text-left space-y-3 animate-fadeIn">
                    <h4 className="font-bold text-center">Here are your top 3 recommendations:</h4>
                    {recommendations.map(rec => <RecommendedNexusCard key={rec.nexusId} recommendation={rec} />)}
                </div>
            )}
        </div>
    );
}

function RecommendedNexusCard({ recommendation }) {
    const { db, appId, collection, doc, getDoc } = useAppContext();
    const [nexus, setNexus] = useState(null);

    useEffect(() => {
        const fetchNexus = async () => {
            const nexusRef = doc(db, `artifacts/${appId}/public/data/nexuses`, recommendation.nexusId);
            const docSnap = await getDoc(nexusRef);
            if (docSnap.exists()) {
                setNexus({ id: docSnap.id, ...docSnap.data() });
            }
        };
        fetchNexus();
    }, [recommendation.nexusId, doc, getDoc, db, appId]);

    if (!nexus) return null;

    return (
        <div className="bg-gray-800/70 p-3 rounded-lg border border-gray-700">
            <NexusCard nexus={nexus} />
            <blockquote className="mt-2 border-l-4 border-purple-400 pl-3 text-sm italic text-gray-300">
                "{recommendation.reason}"
            </blockquote>
        </div>
    );
}


function ConstellationView({ seedWhisper, onClose, publicUserId }) {
    const { userId, db, collection, query, where, getDocs, appId, userProfiles, LucideIcons, setMessage } = useAppContext();

    const isModalMode = !!seedWhisper;
    const isPublicMode = !!publicUserId;
    const targetUserId = isPublicMode ? publicUserId : userId;

    const [nodes, setNodes] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [selectedWhisper, setSelectedWhisper] = useState(null);
    const [dynamics, setDynamics] = useState({ mood: 'neutral', syncs: [] });
    const [init, setInit] = useState(false);
    const [hoveredStar, setHoveredStar] = useState(null);
    const [hoverCardStyle, setHoverCardStyle] = useState({});

    const layout = useConstellationLayout(nodes, targetUserId);

    useEffect(() => {
        initParticlesEngine(async (engine) => {
            await loadFull(engine);
        }).then(() => {
            setInit(true);
        });
    }, []);

    useEffect(() => {
        if (targetUserId) {
            const dynamicsRef = doc(db, `artifacts/${appId}/public/data/constellation_dynamics`, targetUserId);
            const unsubscribe = onSnapshot(dynamicsRef, (doc) => {
                if (doc.exists()) setDynamics(doc.data());
            });
            return () => unsubscribe();
        }
    }, [targetUserId, db, appId]);

    useEffect(() => {
        const fetchData = async () => {
            if (!targetUserId && !isModalMode) return;
            setIsLoading(true);

            if (isModalMode) {
                if (!seedWhisper.constellationId) {
                    setIsLoading(false);
                    return;
                }
                const q = query(collection(db, `artifacts/${appId}/public/data/anonymous_entries`), where("constellationId", "==", seedWhisper.constellationId));
                const snapshot = await getDocs(q);
                const whisperNodes = snapshot.docs.map(doc => ({ id: doc.data().authorId, whisperData: { id: doc.id, ...doc.data() } }));
                setNodes(whisperNodes);
            } else {
                const connectionsSnapshot = await getDocs(collection(db, `artifacts/${appId}/users/${targetUserId}/connections`));
                const connectionIds = connectionsSnapshot.docs.map(d => d.data().followingId);

                if (connectionIds.length === 0) {
                    setNodes([]);
                    setIsLoading(false);
                    return;
                }
                const connectionNodes = connectionIds.map(id => ({ id }));
                setNodes(connectionNodes);
            }
            setIsLoading(false);
        };
        fetchData();
    }, [isModalMode, collection, getDocs, query, where, seedWhisper, targetUserId, db, appId]);

    const handleSelectStar = (node) => {
        if (isPublicMode) return;
        if (isModalMode && node?.whisperData) {
            setSelectedWhisper(node.whisperData);
            return;
        }
        const fetchLatestWhisper = async () => {
            const q = query(collection(db, `artifacts/${appId}/public/data/anonymous_entries`), where("authorId", "==", node.id), orderBy("timestamp", "desc"), limit(1));
            const snapshot = await getDocs(q);
            if (!snapshot.empty) {
                setSelectedWhisper({ id: snapshot.docs[0].id, ...snapshot.docs[0].data() });
            } else {
                setMessage("This user hasn't posted any whispers yet.");
            }
        };
        fetchLatestWhisper();
    };

    const handleShare = () => {
        const url = `${window.location.origin}?page=constellation&userId=${userId}`;
        navigator.clipboard.writeText(url);
        setMessage("Constellation link copied to clipboard!");
    };

    const handleStarHover = (star) => {
        const style = {};
        if (star.x > 85) style.transform = 'translate(-105%, -110%)';
        else if (star.x < 15) style.transform = 'translate(5%, -110%)';
        else style.transform = 'translate(-50%, -110%)';

        if (star.y < 20) {
            style.transform = style.transform.replace('-110%', '20%');
        }
        setHoverCardStyle(style);
        setHoveredStar(star);
    };

    const moodGradients = {
        positive: 'from-yellow-900/50 via-orange-900/60 to-pink-900/70',
        negative: 'from-blue-900/80 via-indigo-900/70 to-gray-900',
        neutral: 'from-gray-900 to-blue-900/70',
    };

    const particleOptions = useMemo(() => ({
        background: { color: { value: "transparent" } },
        fpsLimit: 60,
        interactivity: { events: { onHover: { enable: false }, resize: true }, modes: { bubble: { distance: 400, duration: 2, opacity: 0.8, size: 40 }, repulse: { distance: 200, duration: 0.4 } } },
        particles: { color: { value: "#ffffff" }, links: { color: "#ffffff", distance: 150, enable: false, opacity: 0.1, width: 1 }, collisions: { enable: false }, move: { direction: "none", enable: true, outMode: "out", random: true, speed: 0.1, straight: false }, number: { density: { enable: true, area: 800 }, value: 80 }, opacity: { value: 0.5 }, shape: { type: "circle" }, size: { random: true, value: 1 } },
        detectRetina: true,
    }), []);

    if (!init || isLoading) {
        return <LoadingSpinner message={isPublicMode ? "Loading Public Constellation..." : "Aligning the stars..."} />;
    }

    const containerClasses = isModalMode
        ? "fixed inset-0 bg-black/90 flex items-center justify-center z-50 animate-fadeIn"
        : "relative w-full h-[70vh] bg-black/30 rounded-lg overflow-hidden border border-blue-900/50 shadow-glow";

    return (
        <div className={containerClasses} onClick={isModalMode ? onClose : undefined}>
            <div className={`w-full h-full ${isModalMode ? 'bg-black/50' : ''}`} onClick={isModalMode ? e => e.stopPropagation() : undefined}>
                <div className={`absolute inset-0 bg-gradient-to-br transition-all duration-[2000ms] ${moodGradients[dynamics.mood]}`}></div>
                <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] opacity-30"></div>
                <Particles id="tsparticles" options={particleOptions} />

                {layout.map((star, index) => (
                    <div
                        key={star.id}
                        className={`absolute transform -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-300 star-twinkle ${!isPublicMode ? 'cursor-pointer hover:scale-125 hover:z-20' : ''}`}
                        style={{
                            left: `${star.x}%`,
                            top: `${star.y}%`,
                            width: `${star.size}px`,
                            height: `${star.size}px`,
                            backgroundColor: 'rgba(255, 255, 255, 0.9)',
                            '--animation-delay': `${(index * 0.1).toFixed(2)}s`
                        }}
                        onClick={() => handleSelectStar(star)}
                        onMouseEnter={() => handleStarHover(star)}
                        onMouseLeave={() => setHoveredStar(null)}
                    ></div>
                ))}

                {hoveredStar && (
                    <UserHoverCard
                        profile={userProfiles.find(p => p.id === hoveredStar.id)}
                        position={{ top: `${hoveredStar.y}%`, left: `${hoveredStar.x}%` }}
                        style={hoverCardStyle} />
                )}

                <WhisperInSpace whisper={selectedWhisper} onClose={() => setSelectedWhisper(null)} />

                {!isModalMode && !isPublicMode && (
                    <button onClick={handleShare} className="absolute top-4 left-4 p-2 rounded-full bg-gray-700/80 hover:bg-gray-600/80 text-white transition duration-300" aria-label="Share Constellation">
                        <LucideIcons.Share2 size={20} />
                    </button>
                )}

                {isModalMode && (
                    <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-full bg-gray-700/80 hover:bg-gray-600/80 text-white transition duration-300" aria-label="Close">
                        <LucideIcons.X size={24} />
                    </button>
                )}
            </div>
        </div>
    );
}
function Dashboard() {
    const { currentUserProfile, appFunctions, setMessage, LucideIcons, db, appId, collection, query, where, onSnapshot, showConfirmation, updateDoc, doc } = useAppContext();
    const isOwner = currentUserProfile?.role === 'owner';
    const [activeTab, setActiveTab] = useState(isOwner ? 'monetization' : 'moderation');
    const [flaggedEntries, setFlaggedEntries] = useState([]);
    const [isLoadingFlags, setIsLoadingFlags] = useState(true);
    const [users, setUsers] = useState([]);
    const [isLoadingUsers, setIsLoadingUsers] = useState(true);
    const [aiPersonas, setAiPersonas] = useState([]);
    const [isLoadingPersonas, setIsLoadingPersonas] = useState(true);

    useEffect(() => {
        if (!currentUserProfile || !['moderator', 'admin', 'owner'].includes(currentUserProfile.role)) {
            setIsLoadingFlags(false);
            setIsLoadingUsers(false);
            setIsLoadingPersonas(false);
            return;
        };

        const qFlags = query(collection(db, `artifacts/${appId}/public/data/anonymous_entries`), where("isFlagged", "==", true));
        const unsubFlags = onSnapshot(qFlags, (snapshot) => {
            setFlaggedEntries(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
            setIsLoadingFlags(false);
        });

        const qUsers = query(collection(db, `artifacts/${appId}/public/data/user_profiles`));
        const unsubUsers = onSnapshot(qUsers, (snapshot) => {
            const allUsers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            setUsers(allUsers.filter(u => !u.isAI));
            setAiPersonas(allUsers.filter(u => u.isAI));
            setIsLoadingUsers(false);
            setIsLoadingPersonas(false);
        });

        return () => { unsubFlags(); unsubUsers(); };
    }, [db, collection, onSnapshot, query, where, appId, currentUserProfile]);

    const executeDelete = useCallback(async (entryId) => {
        const deleteWhisper = httpsCallable(appFunctions, 'deleteWhisper');
        try {
            await deleteWhisper({ whisperId: entryId });
            setMessage("Whisper permanently deleted.");
        } catch (error) {
            setMessage(`Failed to delete whisper: ${error.message}`);
        }
    }, [appFunctions, setMessage]);

    const handleDelete = (entryId) => {
        showConfirmation({
            message: "ADMIN ACTION: Are you sure you want to permanently delete this whisper? This cannot be undone.",
            onConfirm: () => executeDelete(entryId)
        });
    };

    const handleMarkSafe = async (entryId) => {
        try {
            await updateDoc(doc(db, `artifacts/${appId}/public/data/anonymous_entries`, entryId), { isFlagged: false });
            setMessage("Content marked as safe.");
        } catch (e) { setMessage(`Failed to mark content safe: ${e.message}`); }
    };

    const handleHideContent = async (entryId) => {
        try {
            await updateDoc(doc(db, `artifacts/${appId}/public/data/anonymous_entries`, entryId), { isHidden: true, isFlagged: false });
            setMessage("Content hidden from public view.");
        } catch (e) { setMessage(`Failed to hide content: ${e.message}`); }
    };

    const handleRoleChange = async (targetUserId, newRole) => {
        try {
            await updateDoc(doc(db, `artifacts/${appId}/public/data/user_profiles`, targetUserId), { role: newRole });
            setMessage(`Role for ${targetUserId} updated to ${newRole}.`);
        } catch (e) { setMessage(`Failed to update role: ${e.message}`); }
    };

    const MonetizationDashboardTab = () => {
        const [isLoadingData, setIsLoadingData] = useState(true);
        const [data, setData] = useState(null);

        const fetchSnapshot = useCallback(async () => {
            setIsLoadingData(true);
            const getMonetizationSnapshot = httpsCallable(appFunctions, 'getMonetizationSnapshot');
            try {
                const result = await getMonetizationSnapshot();
                setData(result.data);
            } catch (error) {
                setMessage(`Failed to load live data: ${error.message}`);
            } finally {
                setIsLoadingData(false);
            }
        }, []);

        useEffect(() => { fetchSnapshot(); }, [fetchSnapshot]);

        const KpiCard = ({ title, value, icon, format = 'number' }) => {
            const Icon = LucideIcons[icon];
            const formattedValue = () => {
                if (format === 'currency') return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                if (format === 'percent') return `${(Number(value) * 100).toFixed(2)}%`;
                return Number(value).toLocaleString();
            };
            return (
                <div className="blueprint-card">
                    <div className="blueprint-muted flex items-center gap-2"><Icon size={14} /> {title}</div>
                    <div className="blueprint-metric blueprint-mono">{formattedValue()}</div>
                </div>
            );
        };

        const engagementChartData = useMemo(() => {
            if (!data?.historicalData) return { labels: [], datasets: [] };
            const labels = data.historicalData.map(d => new Date(d.date).toLocaleDateString());
            return {
                labels,
                datasets: [
                    { label: 'DAU', data: data.historicalData.map(d => d.dau), borderColor: '#9aa5ff', backgroundColor: 'rgba(154, 165, 255, 0.2)', fill: true, tension: 0.3, },
                    { label: 'WAU', data: data.historicalData.map(d => d.wau), borderColor: '#82e6c8', backgroundColor: 'rgba(130, 230, 200, 0.2)', fill: true, tension: 0.3, }
                ]
            };
        }, [data]);

        const featureUsageData = useMemo(() => {
            if (!data?.featureUsage) return { labels: [], datasets: [] };
            const labels = Object.keys(data.featureUsage);
            return { labels, datasets: [{ label: 'Total Uses', data: Object.values(data.featureUsage), backgroundColor: '#82e6c8', borderColor: '#121824', borderWidth: 2 }] };
        }, [data]);

        const engagementChartOptions = { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: '#dfe7ff' }, grid: { color: 'rgba(255,255,255,0.1)' } }, y: { ticks: { color: '#dfe7ff' }, grid: { color: 'rgba(255,255,255,0.1)' } } }, plugins: { legend: { position: 'top', labels: { color: '#dfe7ff' } }, title: { display: true, text: 'Active Users (Last 30 Days)', color: '#dfe7ff', font: { size: 16 } } } };
        const featureUsageOptions = { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: '#dfe7ff' }, grid: { color: 'rgba(255,255,255,0.1)' } }, y: { ticks: { color: '#dfe7ff' }, grid: { display: false } } }, plugins: { legend: { display: false }, title: { display: true, text: 'AI Feature Usage', color: '#dfe7ff', font: { size: 16 } } } };

        if (isLoadingData) return <LoadingSpinner message="Loading Economic Snapshot..." />;
        if (!data) return <div className="text-center text-red-400">Could not load dashboard data.</div>;

        return (
            <div className="space-y-6 animate-fadeIn">
                <style>{`:root { --bg: #0b0f14; --card: #121824; --ink: #dfe7ff; --muted: #9bb0d3; --accent: #82e6c8; --accent-2: #9aa5ff; --radius: 18px; } .blueprint-card { background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,0) 30%), var(--card); border: 1px solid rgba(255,255,255,.07); border-radius: var(--radius); padding: 1.25rem; } .blueprint-grid { display: grid; gap: 1rem; } .blueprint-grid.cols-4 { grid-template-columns: repeat(4, 1fr); } .blueprint-metric { font-weight: 800; font-size: 2rem; } .blueprint-muted { color: var(--muted); font-size: 0.875rem; text-transform: uppercase; } .blueprint-section-title { font-size: 1.25rem; font-weight: 700; color: #c8d3ff; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid rgba(255,255,255,.1); } @media (max-width: 1024px) { .blueprint-grid.cols-4 { grid-template-columns: repeat(2, 1fr); } } @media (max-width: 640px) { .blueprint-grid.cols-4 { grid-template-columns: 1fr; } }`}</style>

                <div className="blueprint-section-title">Platform Overview</div>
                <div className="blueprint-grid cols-4">
                    <KpiCard title="Net Contribution (30d)" value={data.netContribution} icon="DollarSign" format="currency" />
                    <KpiCard title="Monthly Recurring Revenue" value={data.mrr} icon="Repeat" format="currency" />
                    <KpiCard title="ARPU (DAU-based)" value={data.arpu} icon="Users" format="currency" />
                    <KpiCard title="ARPPU (Pro Users)" value={data.arppu} icon="UserCheck" format="currency" />
                    <KpiCard title="Monthly Churn Rate" value={data.churn} icon="TrendingDown" format="percent" />
                    <KpiCard title="Cash Out Ratio" value={data.cashOutRatio} icon="Banknote" format="percent" />
                </div>

                <div className="blueprint-section-title">User Engagement</div>
                <div className="blueprint-card" style={{ height: '300px' }}>
                    <Line data={engagementChartData} options={engagementChartOptions} />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="w-full">
                        <div className="blueprint-section-title">Daily Conversion Funnel</div>
                        <div className="blueprint-card space-y-3">
                            <div className="flex justify-between items-center"><span className="font-semibold">New Users</span><span className="font-bold text-lg">{data.conversionFunnel.new.toLocaleString()}</span></div>
                            <div className="w-full bg-gray-700 rounded-full h-2.5"><div className="bg-blue-500 h-2.5 rounded-full" style={{ width: '100%' }}></div></div>
                            <div className="flex justify-between items-center"><span className="font-semibold">Engaged Users</span><span className="font-bold text-lg">{data.conversionFunnel.engaged.toLocaleString()}</span></div>
                            <div className="w-full bg-gray-700 rounded-full h-2.5"><div className="bg-green-500 h-2.5 rounded-full" style={{ width: `${data.conversionFunnel.new > 0 ? (data.conversionFunnel.engaged / data.conversionFunnel.new) * 100 : 0}%` }}></div></div>
                            <div className="flex justify-between items-center"><span className="font-semibold">Pro Subscribers</span><span className="font-bold text-lg">{data.conversionFunnel.payers.toLocaleString()}</span></div>
                            <div className="w-full bg-gray-700 rounded-full h-2.5"><div className="bg-purple-500 h-2.5 rounded-full" style={{ width: `${data.conversionFunnel.engaged > 0 ? (data.conversionFunnel.payers / data.conversionFunnel.engaged) * 100 : 0}%` }}></div></div>
                        </div>
                    </div>
                    <div className="w-full">
                        <div className="blueprint-section-title">AI Feature Usage</div>
                        <div className="blueprint-card" style={{ height: '250px' }}>
                            <Bar data={featureUsageData} options={featureUsageOptions} />
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div>
                        <div className="blueprint-section-title">Echo Economy Flow</div>
                        <div className="blueprint-card space-y-2">
                            <div className="flex justify-between items-center text-green-400"><span className="flex items-center gap-2"><LucideIcons.PlusCircle size={16} />Created</span><span className="font-mono font-bold">{data.echoVelocity.created.toLocaleString()}</span></div>
                            <div className="flex justify-between items-center text-red-400"><span className="flex items-center gap-2"><LucideIcons.Cpu size={16} />Spent (AI)</span><span className="font-mono font-bold">{data.echoVelocity.spent_ai.toLocaleString()}</span></div>
                            <div className="flex justify-between items-center text-red-400"><span className="flex items-center gap-2"><LucideIcons.Flame size={16} />Spent (Amplify)</span><span className="font-mono font-bold">{data.echoVelocity.spent_amp.toLocaleString()}</span></div>
                        </div>
                    </div>
                    <div>
                        <div className="blueprint-section-title">Top Earning Creators</div>
                        <div className="blueprint-card space-y-2">
                            {data.topCreators.map(user => (
                                <div key={user.id} className="flex items-center justify-between bg-gray-900/50 p-2 rounded-md">
                                    <div className="flex items-center gap-3">
                                        <img src={user.photoURL} alt={user.displayName} className="w-8 h-8 rounded-full" />
                                        <span className="font-semibold">{user.displayName}</span>
                                    </div>
                                    <span className="font-bold text-yellow-400">{user.value.toLocaleString()} Echoes</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div>
                    <div className="blueprint-section-title">Monthly Data Flow Summary</div>
                    <div className="blueprint-card">
                        <p>This section summarizes the flow of real currency through the platform, providing the data needed for a Sankey diagram visualization.</p>
                        <div className="mt-4 space-y-2 font-mono">
                            <p>Stripe Revenue -&gt; Platform: <span className="font-bold text-green-400">${data.sankeyData.fromStripe.toLocaleString()}</span></p>
                            <p>Platform -&gt; Creator Payouts: <span className="font-bold text-red-400">-${data.sankeyData.toCreators.toLocaleString()}</span></p>
                            <p>Platform -&gt; AI Service Costs: <span className="font-bold text-red-400">-${data.sankeyData.toAi.toLocaleString()}</span></p>
                            <p className="border-t border-gray-700 mt-2 pt-2">Platform Net Contribution: <span className="font-bold text-sky-400">${data.sankeyData.toPlatform.toLocaleString()}</span></p>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const ModerationTab = () => (
        <div className="space-y-4">
            {isLoadingFlags ? <LoadingSpinner /> : flaggedEntries.length === 0 ? (
                <p className="text-center text-gray-400 italic py-8">No content is currently flagged for review.</p>
            ) : (
                flaggedEntries.map(entry => (
                    <div key={entry.id} className="bg-red-900/20 p-4 rounded-lg border border-red-700">
                        <p className="text-gray-100 italic mb-2">"{entry.content}"</p>
                        <p className="text-xs text-gray-400">Author ID: {entry.authorId}</p>
                        <div className="flex justify-end space-x-2 mt-2">
                            <button onClick={() => handleMarkSafe(entry.id)} className="small-action-button bg-green-600 hover:bg-green-700">Mark Safe</button>
                            <button onClick={() => handleHideContent(entry.id)} className="small-action-button bg-yellow-600 hover:bg-yellow-700">Hide</button>
                            <button onClick={() => handleDelete(entry.id)} className="small-action-button bg-red-600 hover:bg-red-700">Delete</button>
                        </div>
                    </div>
                ))
            )}
        </div>
    );

    const AdminTab = () => (
        <div className="space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
            {isLoadingUsers ? <LoadingSpinner /> : users.map(user => (
                <div key={user.id} className="bg-gray-800/50 p-3 rounded-lg flex items-center justify-between flex-wrap gap-2">
                    <div>
                        <p className="font-semibold text-white">{user.displayName}</p>
                        <p className="text-xs text-gray-400 font-mono">{user.id}</p>
                    </div>
                    <select value={user.role || 'user'} onChange={(e) => handleRoleChange(user.id, e.target.value)} className="bg-gray-900 text-white rounded-md p-2 border border-gray-700">
                        <option value="user">User</option>
                        <option value="moderator">Moderator</option>
                        {isOwner && <option value="admin">Admin</option>}
                        {isOwner && <option value="owner">Owner</option>}
                    </select>
                </div>
            ))}
        </div>
    );

    const AIFoundryTab = () => {
        const [newPersona, setNewPersona] = useState({ name: '', bio_prompt: '', interests: '' });
        const [isCreating, setIsCreating] = useState(false);

        const handleCreatePersona = async (e) => {
            e.preventDefault();
            if (!newPersona.name || !newPersona.bio_prompt || !newPersona.interests) {
                setMessage("All fields are required to create a persona."); return;
            }
            setIsCreating(true);
            const createAiPersona = httpsCallable(appFunctions, 'createAiPersona');
            try {
                await createAiPersona({ name: newPersona.name, bio_prompt: newPersona.bio_prompt, interests_list: newPersona.interests.split(',').map(i => i.trim()).filter(Boolean) });
                setMessage("AI Persona created successfully!");
                setNewPersona({ name: '', bio_prompt: '', interests: '' });
            } catch (error) {
                console.error("Error creating persona:", error);
                setMessage(`Creation failed: ${error.message}`);
            } finally { setIsCreating(false); }
        };

        const handleDeletePersona = async (aiUserId) => {
            const deleteAiPersona = httpsCallable(appFunctions, 'deleteAiPersona');
            try {
                await deleteAiPersona({ aiUserId });
                setMessage("AI Persona deleted.");
            } catch (error) {
                console.error("Error deleting persona:", error);
                setMessage(`Deletion failed: ${error.message}`);
            }
        };

        return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                    <h3 className="text-lg font-bold mb-3 text-purple-200">Create New Persona</h3>
                    <form onSubmit={handleCreatePersona} className="space-y-4 p-4 bg-gray-800/50 rounded-lg">
                        <input type="text" placeholder="Persona Name (e.g., 'Cosmic Poet')" value={newPersona.name} onChange={(e) => setNewPersona({ ...newPersona, name: e.target.value })} className="w-full bg-gray-900 p-2 rounded-md border border-gray-700" required />
                        <textarea placeholder="Bio Prompt (e.g., 'A mysterious artist who speaks in riddles...')" value={newPersona.bio_prompt} onChange={(e) => setNewPersona({ ...newPersona, bio_prompt: e.target.value })} className="w-full bg-gray-900 p-2 rounded-md border border-gray-700 h-24" required></textarea>
                        <input type="text" placeholder="Interests (comma-separated)" value={newPersona.interests} onChange={(e) => setNewPersona({ ...newPersona, interests: e.target.value })} className="w-full bg-gray-900 p-2 rounded-md border border-gray-700" required />
                        <button type="submit" disabled={isCreating} className="w-full small-action-button bg-purple-600 hover:bg-purple-700 disabled:opacity-50">{isCreating ? 'Forging...' : 'Create Persona'}</button>
                    </form>
                </div>
                <div>
                    <h3 className="text-lg font-bold mb-3 text-purple-200">Manage Personas</h3>
                    <div className="space-y-2 max-h-[40vh] overflow-y-auto custom-scrollbar pr-2">
                        {isLoadingPersonas ? <LoadingSpinner /> : aiPersonas.map(ai => (
                            <div key={ai.id} className="bg-gray-800/50 p-2 rounded-lg flex items-center justify-between">
                                <div className="flex items-center gap-2"><img src={ai.photoURL} alt={ai.displayName} className="w-8 h-8 rounded-full" /><span className="font-semibold text-sm">{ai.displayName}</span></div>
                                <button onClick={() => showConfirmation({ message: `Delete AI persona ${ai.displayName}?`, onConfirm: () => handleDeletePersona(ai.id) })} className="ai-icon-button text-red-500 hover:bg-red-900/50"><LucideIcons.Trash2 size={16} /></button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="p-4 bg-black bg-opacity-50 rounded-lg shadow-lg max-w-6xl mx-auto text-white">
            <h2 className="text-3xl font-bold text-center mb-6 text-blue-300 font-playfair">Command Dashboard</h2>
            <div className="flex justify-center border-b border-gray-700 mb-6 flex-wrap">
                {isOwner && <button onClick={() => setActiveTab('monetization')} className={`profile-tab-button ${activeTab === 'monetization' ? 'active' : ''}`}>Monetization</button>}
                <button onClick={() => setActiveTab('moderation')} className={`profile-tab-button ${activeTab === 'moderation' ? 'active' : ''}`}>Moderation</button>
                <button onClick={() => setActiveTab('admin')} className={`profile-tab-button ${activeTab === 'admin' ? 'active' : ''}`}>User Management</button>
                {isOwner && <button onClick={() => setActiveTab('foundry')} className={`profile-tab-button ${activeTab === 'foundry' ? 'active' : ''}`}>AI Foundry</button>}
            </div>
            <div>
                {activeTab === 'monetization' && isOwner && <MonetizationDashboardTab />}
                {activeTab === 'moderation' && <ModerationTab />}
                {activeTab === 'admin' && <AdminTab />}
                {activeTab === 'foundry' && isOwner && <AIFoundryTab />}
            </div>
        </div>
    );
}

function CreateMomentForm() {
    const { userId, LucideIcons, appFunctions, setMessage, handlePageChange, uploadFile } = useAppContext();
    const [url, setUrl] = useState('');
    const [mediaFile, setMediaFile] = useState(null);
    const [previewUrl, setPreviewUrl] = useState('');
    const [content, setContent] = useState('');
    const [tags, setTags] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isAnonymous, setIsAnonymous] = useState(true);
    const [uploadProgress, setUploadProgress] = useState(0);
    const mediaInputRef = useRef(null);

    const videoUrlRegex = /(https?:\/\/(?:www\.)?(?:instagram\.com|tiktok\.com|facebook\.com|fb\.watch|vimeo\.com|youtube\.com|youtu\.be|soundcloud\.com|dailymotion\.com|twitch\.tv)\/[^\s]+)/;

    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (file && file.type.startsWith('video/')) {
            setMediaFile(file);
            setPreviewUrl(URL.createObjectURL(file));
            setUrl(''); // Clear the URL input if a file is selected
        } else {
            setMessage("Please select a valid video file.");
        }
    };

    const handlePreview = () => {
        if (url.trim() && videoUrlRegex.test(url.trim())) {
            setPreviewUrl(url.trim());
            setMediaFile(null); // Clear the file input if a URL is used
        } else {
            setMessage("Please enter a valid video link from a supported platform.");
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!previewUrl) {
            setMessage("Please upload or preview a video before posting.");
            return;
        }
        setIsSubmitting(true);

        try {
            let finalMediaUrl = previewUrl;
            if (mediaFile) {
                const filePath = `moments/${userId}/${Date.now()}_${mediaFile.name}`;
                finalMediaUrl = await uploadFile(mediaFile, filePath, setUploadProgress);
            }

            const tagsArray = tags.split(',').map(t => t.trim()).filter(Boolean);
            const payload = {
                content: content.trim(),
                tags: tagsArray,
                mediaUrl: finalMediaUrl,
                isAnonymous,
            };

            const createMoment = httpsCallable(appFunctions, 'createMoment');
            const result = await createMoment(payload);
            setMessage(`Moment posted! You earned ${result.data.reward} Echoes.`);
            handlePageChange('moments');

        } catch (error) {
            console.error("Error creating Moment:", error);
            setMessage(`Failed to post Moment: ${error.message}`);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="moment-creation-container">
            <h2 className="text-3xl font-bold text-center mb-6 text-purple-300 font-playfair">Create a Moment</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="text-center text-gray-300 mb-4">
                    <p>Upload a video from your device OR paste a link from YouTube, TikTok, etc.</p>
                </div>

                <div className="flex items-center justify-center">
                    <button type="button" onClick={() => mediaInputRef.current.click()} className="small-action-button bg-indigo-600 hover:bg-indigo-700 text-white text-base px-6 py-3">
                        <LucideIcons.UploadCloud size={20} className="mr-2" /> Upload Video
                    </button>
                    <input type="file" ref={mediaInputRef} onChange={handleFileSelect} className="hidden" accept="video/*" />
                </div>

                <div className="flex items-center gap-2">
                    <input type="text" className="moment-creation-input w-full py-2 px-4 rounded-full" placeholder="Or paste a video link..." value={url} onChange={(e) => setUrl(e.target.value)} />
                    <button type="button" onClick={handlePreview} className="small-action-button bg-blue-600 hover:bg-blue-700 text-white flex-shrink-0">Preview</button>
                </div>

                {isSubmitting && uploadProgress > 0 && <progress value={uploadProgress} max="100" className="w-full accent-purple-500" />}

                {previewUrl && (
                    <div className="player-wrapper rounded-lg overflow-hidden">
                        <ReactPlayer url={previewUrl} playing={true} loop={true} muted={true} controls={true} width="100%" height="100%" className="react-player" />
                    </div>
                )}

                <textarea className="moment-creation-input w-full p-3 rounded-lg resize-y" placeholder="Add a caption..." value={content} onChange={(e) => setContent(e.target.value)} rows="3" />
                <input type="text" className="moment-creation-input w-full py-2 px-4 rounded-full" placeholder="Add tags, separated by commas..." value={tags} onChange={(e) => setTags(e.target.value)} />

                <div className="flex items-center justify-between p-3 bg-black/20 rounded-lg">
                    <label htmlFor="isAnonymousMoment" className="text-gray-300 font-semibold cursor-pointer">Post Anonymously</label>
                    <label className="forge-switch">
                        <input type="checkbox" id="isAnonymousMoment" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} />
                        <span className="forge-slider"></span>
                    </label>
                </div>

                <button type="submit" disabled={isSubmitting || !previewUrl} className="w-full px-8 py-3 bg-purple-600 text-white font-bold rounded-full hover:bg-purple-700 transition duration-300 disabled:opacity-50 flex items-center justify-center gap-2">
                    {isSubmitting ? <div className="action-spinner" /> : <LucideIcons.Send size={18} />}
                    {isSubmitting ? 'Posting...' : 'Post Moment'}
                </button>
            </form>
        </div>
    );
}

const AppSkeleton = () => (
    <div className="min-h-screen bg-cover bg-fixed font-lora text-gray-800 p-4 sm:p-8 relative" style={{ backgroundImage: 'url("https://i.postimg.cc/vHhqVDns/Untitled.gif")', backgroundSize: 'cover', backgroundPosition: 'center' }}>
        <div className="fixed top-4 left-4 p-2 bg-gray-800/50 rounded-full flex items-center space-x-2 z-50 h-[48px] w-[172px]"></div>
        <div className="fixed top-4 right-[4.5rem] p-3 rounded-full bg-blue-500/50 h-[48px] w-[48px]"></div>
        <div className="menu-toggle-button opacity-50"><LucideIcons.Menu size={24} /></div>

        <header className="text-center mb-10 relative z-10 opacity-80">
            <div className="title-container">
                <h1 className="app-title text-4xl sm:text-5xl font-extrabold mb-4 font-playfair" style={{ animation: 'none', opacity: 1 }}>Whispers of Harmony</h1>
            </div>
            <p className="font-playfair text-lg sm:text-xl text-blue-200 italic drop-shadow-md">Connecting souls, inspiring bliss.</p>
        </header>

        <main className="max-w-4xl mx-auto pb-20 relative z-10">
            <LoadingSpinner message="Initializing Harmony..." />
        </main>

        <footer className="text-center mt-10 text-gray-700 text-sm relative z-10 opacity-50">
            <p>© {new Date().getFullYear()} Health & Legend LLC. All rights reserved.</p>
        </footer>
    </div>
);
// In App.js, replace the old MediaViewerModal with this one.
const UniversalMediaViewer = ({ mediaData, onClose, LucideIcons }) => {
    if (!mediaData) return null;

    const renderContent = () => {
        if (mediaData.type === 'direct') {
            const isVideo = ['.mp4', '.webm'].some(ext => mediaData.url.toLowerCase().includes(ext));
            if (isVideo) {
                return <video src={mediaData.url} controls autoPlay className="max-w-full max-h-full rounded-lg" />;
            }
            return <img src={mediaData.url} alt="Expanded media" className="max-w-full max-h-full rounded-lg object-contain" />;
        }
        // For link previews, we just show the image if it exists
        if (mediaData.type === 'link_preview' && mediaData.thumbnail) {
            return <img src={mediaData.thumbnail} alt={mediaData.title} className="max-w-full max-h-full rounded-lg object-contain" />;
        }
        // Fallback for other types or if thumbnail is missing
        return (
            <div className="p-8 bg-gray-800 rounded-lg text-center">
                <p className="text-lg">This content is best viewed on its original page.</p>
                <a href={mediaData.url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block small-action-button bg-blue-600 hover:bg-blue-700">
                    Visit Link <LucideIcons.ExternalLink size={14} className="ml-2" />
                </a>
            </div>
        );
    };

    return (
        <div className="modal-overlay animate-fadeIn" onClick={onClose}>
            <div className="relative max-w-4xl max-h-[90vh] w-full h-full flex items-center justify-center" onClick={e => e.stopPropagation()}>
                <button onClick={onClose} className="absolute -top-10 right-0 md:top-2 md:-right-12 p-2 rounded-full bg-gray-700/50 hover:bg-gray-600/50 text-white transition duration-300" aria-label="Close">
                    <LucideIcons.X size={24} />
                </button>
                {renderContent()}
            </div>
        </div>
    );
};

function App() {
    const [cachedFeed, setCachedFeed] = useState(null);
    const [user, setUser] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [appParams, setAppParams] = useState(null);
    const [message, setMessage] = useState('');
    const [currentPage, setCurrentPage] = useState('anonymousFeed');
    const [selectedChatUser, setSelectedChatUser] = useState(null);
    const [userProfiles, setUserProfiles] = useState([]);
    const [userConnections, setUserConnections] = useState([]);
    const [showMoodInsightModal, setShowMoodInsightModal] = useState(false);
    const [moodInsightContent, setMoodInsightContent] = useState('');
    const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
    const [profileToViewId, setProfileToViewId] = useState(null);
    const [onlineStatus, setOnlineStatus] = useState({});
    const [showAuraChamber, setShowAuraChamber] = useState(false);
    const [entryToScrollTo, setEntryToScrollTo] = useState(null);
    const [confirmation, setConfirmation] = useState(null);
    const [showProModal, setShowProModal] = useState(false);
    const [mediaToView, setMediaToView] = useState(null);
    const [nexusToViewId, setNexusToViewId] = useState(null);
    const [activeToast, setActiveToast] = useState(null);
    const notificationQueue = useRef([]);
    const isToastVisible = useRef(false);
    const [isSplashTimeOver, setIsSplashTimeOver] = useState(false);

    const auth = firebaseAuth;
    const db = firestoreDb;
    const storage = firebaseStorage;
    const appFunctions = firebaseFunctions;

    const stripePromise = useMemo(() =>
        loadStripe('pk_live_51RozX98FT6FNb22O8VtarwAIuzw5R0nrOvB4vp9WZVi7FWOE9A9hPDTVRFPLYsCNEb8w0ig7UNssMYrBEKYGA8ss00RdhtPBhD'),
        []);

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsSplashTimeOver(true);
        }, 5000);
        return () => clearTimeout(timer);
    }, []);

    const showConfirmation = useCallback(({ message, onConfirm, onCancel }) => {
        setConfirmation({
            message,
            onConfirm: () => { onConfirm(); setConfirmation(null); },
            onCancel: () => { if (onCancel) onCancel(); setConfirmation(null); }
        });
    }, []);

    const updateUserProfileInState = useCallback((userId, newData) => {
        setUserProfiles(prevProfiles =>
            prevProfiles.map(p =>
                p.id === userId ? { ...p, ...newData } : p
            )
        );
    }, []);

    const processQueue = useCallback(() => {
        if (isToastVisible.current || notificationQueue.current.length === 0) {
            return;
        }
        isToastVisible.current = true;
        const notification = notificationQueue.current.shift();
        setActiveToast(notification);

        // Immediately delete the toast from Firestore after it has been queued
        if (notification?.id) {
            const toastRef = doc(db, `artifacts/${appId}/users/${userId}/toast_notifications`, notification.id);
            deleteDoc(toastRef).catch(e => console.error("Error deleting toast notification:", e));
        }
    }, [userId, db, appId]);

    useEffect(() => {
        if (!userId || !db) return;
        const q = query(
            collection(db, `artifacts/${appId}/users/${userId}/toast_notifications`),
            orderBy("timestamp", "asc") // Fetch in ascending order to process oldest first
        );
        const unsubscribe = onSnapshot(q, (snapshot) => {
            snapshot.docChanges().forEach((change) => {
                if (change.type === "added") {
                    const newToast = { id: change.doc.id, ...change.doc.data() };
                    notificationQueue.current.push(newToast);
                    processQueue();
                }
            });
        });
        return () => unsubscribe();
    }, [userId, db, appId, processQueue]);

    useEffect(() => {
        if (userId && user && !user.isAnonymous && db) {
            const userProfileRef = doc(db, `artifacts/${appId}/public/data/user_profiles`, userId);
            updateDoc(userProfileRef, {
                lastActiveTimestamp: serverTimestamp()
            }).catch(err => {
                console.log("Note: Could not set initial activity timestamp.");
            });
        }
    }, [userId, user, db, appId]);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const page = params.get('page') || 'anonymousFeed';
        const targetUserId = params.get('userId');
        const chatPartnerId = params.get('chatPartnerId');
        const scrollToEntryId = params.get('scrollToEntry');
        const nexusId = params.get('nexusId');

        setCurrentPage(page);
        if (targetUserId) setProfileToViewId(targetUserId);
        if (scrollToEntryId) setEntryToScrollTo(scrollToEntryId);
        if (nexusId) setNexusToViewId(nexusId);

        if (page === 'messages' && chatPartnerId && userProfiles.length > 0) {
            const profile = userProfiles.find(p => p.id === chatPartnerId);
            if (profile) {
                setSelectedChatUser({ id: profile.id, displayName: profile.displayName });
            }
        }
    }, [userProfiles]);

    useEffect(() => {
        if (!auth || !db || !storage || !appFunctions) {
            console.error("Firebase services not initialized.");
            setMessage("Application cannot start: Firebase services not available.");
            setIsAuthReady(true);
            return;
        }

        const signInAndSetup = async (currentUser) => {
            setUser(currentUser);
            const currentUid = currentUser?.uid || crypto.randomUUID();
            setUserId(currentUid);

            if (currentUser && !currentUser.isAnonymous) {
                const userProfileRef = doc(db, `artifacts/${appId}/public/data/user_profiles`, currentUser.uid);
                const docSnap = await getDoc(userProfileRef);

                if (!docSnap.exists()) {
                    try {
                        await setDoc(userProfileRef, {
                            displayName: currentUser.displayName || 'Anonymous User',
                            email: currentUser.email || null,
                            photoURL: currentUser.photoURL || null,
                            createdAt: serverTimestamp(),
                            role: 'user',
                            tokens: 100,
                        });
                    } catch (e) {
                        console.error("Error creating user profile:", e);
                    }
                }
            }

            if (!isAuthReady) {
                setIsAuthReady(true);
            }
        };

        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            if (currentUser) {
                await signInAndSetup(currentUser);
            } else {
                try {
                    if (initialAuthToken) {
                        const userCredential = await signInWithCustomToken(auth, initialAuthToken);
                        await signInAndSetup(userCredential.user);
                    } else if (!auth.currentUser) {
                        const userCredential = await signInAnonymously(auth);
                        await signInAndSetup(userCredential.user);
                    }
                } catch (error) {
                    console.error("Error during initial sign-in:", error);
                    setMessage(`Authentication Error: ${error.message}. Please try again.`);
                    setIsAuthReady(true);
                }
            }
        });

        return () => unsubscribe();
    }, [auth, db, storage, appFunctions, isAuthReady, appId]);

    useEffect(() => {
        if (!userId || !rtdb) return;
        const userStatusRef = rtdbRef(rtdb, `/status/${userId}`);
        const allStatusesRef = rtdbRef(rtdb, '/status');
        const isOnline = { state: 'online', last_changed: rtdbServerTimestamp() };
        set(userStatusRef, isOnline);
        const isOffline = { state: 'offline', last_changed: rtdbServerTimestamp() };
        onDisconnect(userStatusRef).set(isOffline);
        const unsubscribe = onValue(allStatusesRef, (snapshot) => setOnlineStatus(snapshot.val() || {}));
        return () => { unsubscribe(); set(userStatusRef, isOffline); };
    }, [userId, rtdb]);

    useEffect(() => {
        const loadParams = async () => {
            try {
                const params = await fetchAppParameters();
                setAppParams(params);
            } catch (e) {
                console.error("Failed to load app parameters:", e);
                setMessage("Failed to load application data. Please refresh.");
            }
        };
        loadParams();
    }, []);

    const uploadFile = useCallback(async (file, filePath, onProgress) => {
        if (!storage) throw new Error("Firebase Storage not initialized.");
        return new Promise((res, rej) => {
            const uploadTask = uploadBytesResumable(ref(storage, filePath), file);
            uploadTask.on('state_changed', s => onProgress((s.bytesTransferred / s.totalBytes) * 100), rej, () => getDownloadURL(uploadTask.snapshot.ref).then(res).catch(rej));
        });
    }, [storage]);

    const updateUserProfile = useCallback(async (targetId, data) => {
        if (!targetId || !db) throw new Error("User ID or database not initialized.");
        await updateDoc(doc(db, `artifacts/${appId}/public/data/user_profiles`, targetId), data);
    }, [db, appId]);

    const updateUserTokens = useCallback(async (targetId, tokenChange) => {
        if (!db) { console.error("Database not initialized."); return; }
        const userProfileRef = doc(db, `artifacts/${appId}/public/data/user_profiles`, targetId);
        try {
            await updateDoc(userProfileRef, { tokens: increment(tokenChange) });
        } catch (e) {
            if (e.code === 'not-found') {
                await setDoc(userProfileRef, { tokens: tokenChange }, { merge: true });
            } else {
                console.error(`Error updating tokens for ${targetId}:`, e);
            }
        }
    }, [db, appId]);

    const connectUser = useCallback(async (targetId) => {
        if (!userId || !user || !db) return;
        try {
            await setDoc(doc(db, `artifacts/${appId}/users/${userId}/connections`, targetId), { followingId: targetId, timestamp: serverTimestamp() });
            await addDoc(collection(db, `artifacts/${appId}/users/${targetId}/notifications`), { type: 'CONNECTION', fromUserId: userId, fromUserName: user?.displayName || 'Anonymous User', message: `connected with you!`, timestamp: serverTimestamp(), read: false });
        } catch (e) { console.error("Error connecting:", e); setMessage(`Failed to connect: ${e.message}`); }
    }, [userId, user, db, setMessage, appId]);

    const disconnectUser = useCallback(async (targetId) => {
        if (!userId || !user || !db) return;
        try { await deleteDoc(doc(db, `artifacts/${appId}/users/${userId}/connections`, targetId)); }
        catch (e) { console.error("Error disconnecting:", e); setMessage(`Failed to disconnect: ${e.message}`); }
    }, [userId, user, db, setMessage, appId]);

    const generateContentWithGemini = useCallback(async (prompt) => {
        if (!appFunctions) {
            setMessage("Application functions are not initialized.");
            return null;
        }
        const currentUserProfile = userProfiles.find(p => p.id === userId);
        let modifiedPrompt = prompt;
        if (currentUserProfile?.aiMaxWordCount) {
            modifiedPrompt = `${prompt}\n\nIMPORTANT: Keep your response concise and under ${currentUserProfile.aiMaxWordCount} words.`;
        }
        const callGenerateContent = httpsCallable(appFunctions, 'generateContentWithVertexAI');
        try {
            const result = await callGenerateContent({ prompt: modifiedPrompt });
            return result.data.text;
        } catch (error) {
            console.error("Error calling generateContentWithVertexAI:", error);
            setMessage(`AI generation failed: ${error.message}`);
            return null;
        }
    }, [appFunctions, setMessage, userProfiles, userId]);

    const checkContentForSafety = useCallback(async (text, isHumanEntry = false) => {
        if (!isHumanEntry || !appFunctions) return { flagged: false };
        const callModerateContent = httpsCallable(appFunctions, 'moderateContent');
        try {
            const result = await callModerateContent({ text });
            return result.data;
        } catch (error) {
            console.error("Error calling moderateContent:", error);
            return { flagged: false };
        }
    }, [appFunctions]);

    useEffect(() => {
        if (!db || !userId || !isAuthReady) return;
        const unsub = onSnapshot(collection(db, `artifacts/${appId}/public/data/user_profiles`), (snap) => {
            setUserProfiles(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }, (e) => { console.error("Error listening to user profiles:", e); });
        return () => unsub();
    }, [userId, db, isAuthReady, appId]);

    useEffect(() => {
        if (!db || !userId || !user || !isAuthReady) {
            setUserConnections([]);
            return;
        }
        const unsub = onSnapshot(collection(db, `artifacts/${appId}/users/${userId}/connections`), (snap) => setUserConnections(snap.docs.map(d => ({ id: d.id, ...d.data() }))), (e) => { console.error("Error fetching user connections:", e); });
        return () => unsub();
    }, [userId, user, db, isAuthReady, appId]);

    const signInWithGoogle = useCallback(async () => {
        if (!auth) { setMessage("Authentication service not initialized."); throw new Error("Auth service not initialized."); }
        return await signInWithPopup(auth, new GoogleAuthProvider());
    }, [auth]);

    const signOutUser = useCallback(async () => {
        if (!auth) { setMessage("Authentication service not initialized."); throw new Error("Auth service not initialized."); }
        await signOut(auth);
        setUser(null);
        setUserId(null);
        setCurrentPage('anonymousFeed');
    }, [auth]);

    const handlePageChange = useCallback((newPage, params = {}) => {
        setProfileToViewId(null);
        setSelectedChatUser(null);
        setNexusToViewId(null);

        const canAccess = user && !user.isAnonymous;
        const publicPages = ['anonymousFeed', 'users', 'settings', 'publicConstellation', 'viewingProfile', 'leaderboards', 'nexus', 'moments'];

        if (!canAccess && !publicPages.includes(newPage)) {
            setMessage('Please sign in to access this feature. The sign-in button is in the navigation menu.');
            return;
        }

        setCurrentPage(newPage);
        if (params.userId) setProfileToViewId(params.userId);
        if (params.nexusId) setNexusToViewId(params.nexusId);
        if (params.chatPartnerId) {
            const profile = userProfiles.find(p => p.id === params.chatPartnerId);
            if (profile) setSelectedChatUser({ id: profile.id, displayName: profile.displayName });
        }

        const url = new URL(window.location);
        url.searchParams.set('page', newPage);
        ['userId', 'chatPartnerId', 'tab', 'nexusId'].forEach(p => url.searchParams.delete(p));
        for (const key in params) {
            if (params[key]) url.searchParams.set(key, params[key]);
        }
        window.history.pushState({}, '', url);

        setIsSidePanelOpen(false);
    }, [user, userProfiles]);

    const handleUserSelect = useCallback((targetUserId) => {
        if (targetUserId) handlePageChange('viewingProfile', { userId: targetUserId });
    }, [handlePageChange]);

    const handleSelectUserForMessage = useCallback((targetId, targetName) => {
        handlePageChange('messages', { chatPartnerId: targetId });
    }, [handlePageChange]);

    const handleBackToUsers = useCallback(() => {
        setSelectedChatUser(null);
        handlePageChange('messages');
    }, [handlePageChange]);

    const currentUserProfile = useMemo(() => userProfiles.find(p => p.id === userId), [userProfiles, userId]);
    const canAccessDashboard = currentUserProfile && ['moderator', 'admin', 'owner'].includes(currentUserProfile.role);

    if (!isAuthReady || !appParams || !isSplashTimeOver) {
        return <SplashScreen />;
    }

    if (currentUserProfile && currentUserProfile.status === 'banned') {
        return (
            <div className="min-h-screen bg-cover bg-fixed font-lora text-gray-800 p-4 sm:p-8 flex items-center justify-center" style={{ backgroundImage: 'url("https://i.postimg.cc/vHhqVDns/Untitled.gif")', backgroundSize: 'cover', backgroundPosition: 'center', }}>
                <div className="bg-red-900/80 backdrop-blur-md text-white p-8 rounded-lg shadow-lg text-center border border-red-500">
                    <LucideIcons.Ban size={48} className="mx-auto mb-4 text-red-400" />
                    <h1 className="text-3xl font-bold text-red-300">Account Suspended</h1>
                    <p className="mt-4">Your access to this application has been restricted.</p>
                    {/* --- THIS IS THE FIX --- */}
                    {currentUserProfile.banReason && (
                        <p className="mt-2 text-sm bg-black/20 p-2 rounded-md">Reason: {currentUserProfile.banReason}</p>
                    )}
                    <button onClick={signOutUser} className="mt-6 small-action-button bg-gray-600 hover:bg-gray-700">Sign Out</button>
                </div>
            </div>
        );
    }

    const NavigationHandle = () => (
        <div className="navigation-handle" onClick={() => setIsSidePanelOpen(true)} role="button" aria-label="Open navigation menu" tabIndex="0" onKeyPress={(e) => e.key === 'Enter' && setIsSidePanelOpen(true)}>
            <div className="flex flex-col items-center"><LucideIcons.Menu size={24} className="handle-icon" /></div>
        </div>
    );

    return (
        <AppContext.Provider value={{
            user, userId, signInWithGoogle, setMediaToView, signOutUser, updateUserProfile, connectUser, disconnectUser, userProfiles, userConnections,
            generateContentWithGemini, db, auth, storage, appFunctions, updateUserTokens, checkContentForSafety,
            getDoc, collection, addDoc, query, where, getDocs, onSnapshot, doc, deleteDoc, updateDoc, setDoc, arrayUnion, arrayRemove, orderBy, limit, startAfter, writeBatch, serverTimestamp, uploadFile, LucideIcons,
            setShowMoodInsightModal, setMoodInsightContent, setMessage, appParams, increment, deleteField, appId,
            handleUserSelect, onlineStatus, currentUserProfile, cachedFeed, setCachedFeed,
            handlePageChange, setEntryToScrollTo, entryToScrollTo, showConfirmation, setShowAuraChamber, selectedChatUser, handleSelectUserForMessage, handleBackToUsers,
            setShowProModal, stripePromise, TOKEN_COSTS, updateUserProfileInState,
        }}>
            <div className="min-h-screen bg-cover bg-fixed font-lora text-gray-800 relative flex flex-col" style={{ backgroundImage: 'url("https://i.postimg.cc/vHhqVDns/Untitled.gif")', backgroundSize: 'cover', backgroundPosition: 'center', }}>
                {confirmation && <MessageBox message={confirmation.message} onConfirm={confirmation.onConfirm} onClose={confirmation.onCancel} showConfirm={true} />}

                {mediaToView && <UniversalMediaViewer mediaData={mediaToView} onClose={() => setMediaToView(null)} LucideIcons={LucideIcons} />}

                {showProModal && <HarmonyProModal onClose={() => setShowProModal(false)} />}
                {activeToast && (
                    <NotificationToast
                        key={activeToast.id}
                        notification={activeToast}
                        onClose={() => {
                            isToastVisible.current = false;
                            setActiveToast(null);
                            setTimeout(() => processQueue(), 500);
                        }}
                    />
                )}
                <MusicPlayer LucideIcons={LucideIcons} />
                {currentUserProfile && (
                    <div className="fixed top-4 right-4 p-2 bg-gray-800/70 backdrop-blur-sm rounded-full flex items-center space-x-2 z-50 text-white font-bold text-sm">
                        <LucideIcons.Gem size={16} className="text-purple-400" />
                        <span>{currentUserProfile.tokens || 0}</span>
                    </div>
                )}
                {user && userId && !user.isAnonymous && (<MoodIndicator user={user} setShowAuraChamber={setShowAuraChamber} LucideIcons={LucideIcons} />)}
                {showAuraChamber && <AuraChamber onClose={() => setShowAuraChamber(false)} />}
                {!isSidePanelOpen && <NavigationHandle />}

                <div className={`side-panel z-40 ${isSidePanelOpen ? 'open' : ''}`} onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-col h-full">
                        <div className="flex justify-end mb-4"><button onClick={() => setIsSidePanelOpen(false)} className="text-gray-400 hover:text-white"><LucideIcons.X size={28} /></button></div>
                        <h3 className="text-2xl font-bold text-blue-300 font-playfair mb-6 text-center flex-shrink-0">Navigation</h3>
                        <div className="flex-grow overflow-y-auto custom-scrollbar flex flex-col gap-3">
                            <button onClick={() => handlePageChange('moments')} className={`cloud-button ${currentPage === 'moments' ? 'bg-blue-700' : ''}`}><LucideIcons.PlaySquare size={20} /><span className="text-sm">Moments</span></button>
                            <button onClick={() => handlePageChange('anonymousFeed')} className={`cloud-button ${currentPage === 'anonymousFeed' ? 'bg-blue-700' : ''}`}><LucideIcons.Feather size={20} /><span className="text-sm">Feed</span></button>
                            {user && !user.isAnonymous && (<button onClick={() => handlePageChange('createMoment')} className={`cloud-button ${currentPage === 'createMoment' ? 'bg-blue-700' : ''}`}><LucideIcons.Video size={20} /><span className="text-sm">New Moment</span></button>)}
                            {user && !user.isAnonymous && (<button onClick={() => handlePageChange('myMoments')} className={`cloud-button ${currentPage === 'myMoments' ? 'bg-blue-700' : ''}`}><LucideIcons.UserSquare size={20} /><span className="text-sm">My Moments</span></button>)}
                            {user && !user.isAnonymous && (<button onClick={() => handlePageChange('walletHub')} className={`cloud-button ${currentPage === 'walletHub' ? 'bg-blue-700' : ''}`}><LucideIcons.Wallet size={20} /><span className="text-sm">My Hub</span></button>)}
                            {user && !user.isAnonymous && (<button onClick={() => handlePageChange('newEntry')} className={`cloud-button ${currentPage === 'newEntry' ? 'bg-blue-700' : ''}`}><LucideIcons.Plus size={20} /><span className="text-sm">New Whisper</span></button>)}
                            {user && !user.isAnonymous && (<button onClick={() => handlePageChange('viewingProfile', { userId: userId })} className={`cloud-button ${currentPage === 'viewingProfile' && profileToViewId === userId ? 'bg-blue-700' : ''}`}><LucideIcons.Book size={20} /><span className="text-sm">My Profile</span></button>)}
                            <button onClick={() => handlePageChange('users')} className={`cloud-button ${currentPage === 'users' ? 'bg-blue-700' : ''}`}><LucideIcons.Users size={20} /><span className="text-sm">Users</span></button>
                            <button onClick={() => handlePageChange('nexus')} className={`cloud-button ${currentPage === 'nexus' ? 'bg-blue-700' : ''}`}><LucideIcons.AppWindow size={20} /><span className="text-sm">Nexus</span></button>
                            <button onClick={() => handlePageChange('leaderboards')} className={`cloud-button ${currentPage === 'leaderboards' ? 'bg-blue-700' : ''}`}><LucideIcons.Trophy size={20} /><span className="text-sm">Leaders</span></button>
                            {user && !user.isAnonymous && (<button onClick={() => handlePageChange('connectedFeed')} className={`cloud-button ${currentPage === 'connectedFeed' ? 'bg-blue-700' : ''}`}><LucideIcons.HeartHandshake size={20} /><span className="text-sm">Connected</span></button>)}
                            {user && !user.isAnonymous && (
                                <button onClick={() => handlePageChange('messages')} className={`relative cloud-button ${currentPage === 'messages' ? 'bg-blue-700' : ''}`}>
                                    <LucideIcons.MessageSquare size={20} />
                                    <span className="text-sm">Messages</span>
                                    {currentUserProfile?.hasUnreadMessages && (
                                        <span className="absolute top-2 right-2 w-3 h-3 bg-red-500 rounded-full border-2 border-gray-800 animate-pulse"></span>
                                    )}
                                </button>
                            )}
                            {user && !user.isAnonymous && (<button onClick={() => handlePageChange('notifications')} className={`cloud-button ${currentPage === 'notifications' ? 'bg-blue-700' : ''}`}><LucideIcons.Bell size={20} /><span className="text-sm">Notifications</span></button>)}
                            {canAccessDashboard && (<button onClick={() => handlePageChange('dashboard')} className={`cloud-button ${currentPage === 'dashboard' ? 'bg-blue-700' : ''}`}><LucideIcons.ShieldCheck size={20} /><span className="text-sm">Dashboard</span></button>)}
                            <button onClick={() => handlePageChange('settings')} className={`cloud-button ${currentPage === 'settings' ? 'bg-blue-700' : ''}`}><LucideIcons.Settings size={20} /><span className="text-sm">Settings</span></button>
                        </div>
                        <div className="flex-shrink-0 pt-4 mt-4 border-t border-gray-700">
                            <AuthButton setCurrentPage={handlePageChange} />
                        </div>
                    </div>
                </div>

                <div className="relative flex flex-col flex-grow p-4 sm:p-8 min-h-0">
                    <header className="text-center mb-10 flex-shrink-0">
                        <div className="title-container">
                            <h1 className="app-title text-4xl sm:text-5xl md:text-6xl font-extrabold mb-4 font-playfair">Whispers of Harmony</h1>
                        </div>
                        <p className="font-playfair text-lg sm:text-xl md:text-2xl text-blue-200 italic drop-shadow-md">Connecting souls, inspiring bliss.</p>
                    </header>

                    <main className="max-w-4xl mx-auto w-full flex-grow min-h-0">
                        <div key={currentPage} className="page-container h-full">
                            <ErrorBoundary showDetails={true}>
                                {message && <MessageBox message={message} onClose={() => setMessage('')} />}
                                {currentPage === 'anonymousFeed' && <AnonymousFeed />}
                                {currentPage === 'createMoment' && user && !user.isAnonymous && <CreateMomentForm />}
                                {currentPage === 'moments' && <ReelsViewer />}
                                {currentPage === 'myMoments' && user && !user.isAnonymous && <MyMomentsPage />}
                                {currentPage === 'walletHub' && user && userId && <WalletHub />}
                                {currentPage === 'newEntry' && user && !user.isAnonymous && <JournalEntryForm />}
                                {currentPage === 'users' && <UsersList onUserSelect={handleUserSelect} />}
                                {currentPage === 'leaderboards' && <LeaderboardPage />}
                                {currentPage === 'viewingProfile' && profileToViewId && (<UserProfile profileUserId={profileToViewId} onMessageUser={handleSelectUserForMessage} onToggleConnection={(targetId, isCurrentlyConnected) => {
                                    if (isCurrentlyConnected) { disconnectUser(targetId); } else { connectUser(targetId); }
                                }} />)}
                                {currentPage === 'connectedFeed' && user && userId && <ConnectionHub />}
                                {currentPage === 'publicConstellation' && profileToViewId && <ConstellationView publicUserId={profileToViewId} />}
                                {currentPage === 'messages' && user && userId && <MessagesPage />}
                                {currentPage === 'notifications' && <NotificationsComponent />}
                                {currentPage === 'dashboard' && canAccessDashboard && <Dashboard />}
                                {currentPage === 'settings' && <SettingsComponent />}
                                {currentPage === 'nexus' && nexusToViewId && <NexusHub nexusId={nexusToViewId} />}
                                {currentPage === 'nexus' && !nexusToViewId && <NexusPage />}
                            </ErrorBoundary>
                        </div>
                    </main>

                    <footer className="text-center mt-10 text-gray-700 text-sm flex-shrink-0">
                        <p>© {new Date().getFullYear()} Health & Legend LLC. All rights reserved.</p>
                    </footer>
                </div>
            </div>
        </AppContext.Provider>
    );
}
export default App;
