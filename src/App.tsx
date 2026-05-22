import React, { useState, useRef, useEffect } from 'react';
import { Camera, Upload, Scissors, Sparkles, RefreshCw, AlertCircle, Image as ImageIcon, ChevronRight, X, Maximize2, Zap, Settings, Coins } from 'lucide-react';
import { auth, db, storage } from './firebase';
import { signInAnonymously } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, increment } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';
import { handleFirestoreError, OperationType } from './firebase';

// The LazyImage component generates reference images on demand via Gemini
const globalImageCache: Record<string, string> = {};

const LazyImage = ({ keyword, gender, uniqueName, description, className, autoLoad = false, results }: { keyword: string, gender: string, uniqueName: string, description?: string, className?: string, autoLoad?: boolean, results?: AnalysisResult }) => {
  const cacheKey = `${gender}_${keyword}`;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(globalImageCache[cacheKey] || null);
  const [isLoading, setIsLoading] = useState(autoLoad && !globalImageCache[cacheKey]);
  const [errorString, setErrorString] = useState<string | null>(null);

  const generateImage = async () => {
    if (globalImageCache[cacheKey]) {
      setLoadedUrl(globalImageCache[cacheKey]);
      setIsLoading(false);
      return;
    }
    
    setIsLoading(true);
    setErrorString(null);
    
    try {
      const apiKey = localStorage.getItem('customGeminiApiKey') || '';
      const response = await fetch('/api/generate-reference', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          keyword, 
          gender,
          faceShape: results?.faceShape,
          hairDensity: results?.hairDensity,
          hairType: results?.hairType,
          skinTone: results?.skinTone,
          skinDetails: results?.skinDetails,
          hairColor: results?.hairColor,
          eyeColor: results?.eyeColor,
          ageRange: results?.ageRange,
          facialFeatures: results?.facialFeatures
        })
      });
      
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate image');
      }
      
      if (data.imageUrl) {
        globalImageCache[cacheKey] = data.imageUrl;
        setLoadedUrl(data.imageUrl);
      } else {
        throw new Error('No image URL in response');
      }
    } catch(err: any) {
      console.error("Failed to load reference image", err);
      let errMsg = err.message || "Сбой загрузки";
      if (err.message && (err.message.toLocaleLowerCase().includes('лимит') || err.message.includes('429') || err.message.includes('quota'))) {
        errMsg = "ЛИМИТ. НУЖЕН КЛЮЧ В ⚙️";
      } else if (err.message && err.message.toLocaleLowerCase().includes('ключ')) {
        errMsg = "НУЖЕН КЛЮЧ В ⚙️";
      } else if (errMsg.length > 50) {
        errMsg = errMsg.substring(0, 47) + "...";
      }
      setErrorString(errMsg);
    }
    
    setIsLoading(false);
  };

  useEffect(() => {
    if (autoLoad) {
      const t = setTimeout(() => generateImage(), Math.random() * 500);
      return () => clearTimeout(t);
    }
  }, [keyword, gender, uniqueName, autoLoad]);

  if (loadedUrl) {
    return (
      <img 
        src={loadedUrl} 
        alt={uniqueName} 
        className={className} 
      />
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center bg-transparent text-white/90 border-r border-white/10 ${className || ''}`}>
      {isLoading ? (
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-white/10 border-t-white animate-spin"></div>
          <span className="text-[10px] text-white/60 font-mono uppercase tracking-wider text-center leading-tight">Загрузка<br/>референса...</span>
        </div>
      ) : errorString ? (
        <div className="flex flex-col items-center gap-2 px-2 text-center">
          <AlertCircle size={20} className="text-red-500 opacity-80" />
          <span className="text-red-500 text-[10px] uppercase font-medium leading-tight">{errorString}</span>
          <button 
            onClick={(e) => { e.stopPropagation(); generateImage(); }}
            className="mt-1 text-[9px] bg-white/10 hover:bg-white/10 text-white/90 px-3 py-1.5 rounded uppercase tracking-wider transition-colors"
          >
            Повторить
          </button>
        </div>
      ) : (
        <button onClick={(e) => { e.stopPropagation(); generateImage(); }} className="flex flex-col items-center gap-2 group p-4 hover:bg-white/5 rounded-xl transition-colors">
          <ImageIcon className="w-8 h-8 text-white/40 group-hover:text-white/80 transition-colors" />
          <span className="text-[10px] text-white/60 font-mono uppercase tracking-wider text-center leading-tight group-hover:text-white/90">Показать<br/>пример</span>
        </button>
      )}
    </div>
  );
};

interface AnalysisResult {
  warning?: string;
  gender: string;
  faceShape: string;
  hairDensity: string;
  hairType: string;
  skinTone?: string;
  skinDetails?: string;
  hairColor?: string;
  eyeColor?: string;
  ageRange?: string;
  facialFeatures?: string;
  recommendations: Array<{
    name: string;
    description: string;
    stylingTips: string;
    imageKeyword: string;
  }>;
}

const FallbackImage = 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80';

// Removed queue for simpler operation


export default function App() {
  const [tryOnStyle, setTryOnStyle] = useState<any | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [results, setResults] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);

  const [isGeneratingAR, setIsGeneratingAR] = useState(false);
  const [arGeneratedImageUrl, setArGeneratedImageUrl] = useState<Record<string, string>>({});
  const [styleConsultations, setStyleConsultations] = useState<Record<string, string>>({});
  const [arError, setArError] = useState<string | null>(null);
  
  const [sliderPosition, setSliderPosition] = useState(50);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [consentGiven, setConsentGiven] = useState(false);
  const [consentError, setConsentError] = useState(false);

  const [generationsLeft, setGenerationsLeft] = useState<number | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  useEffect(() => {
    // Check Telegram
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.expand?.();
      if ((tg as any).setHeaderColor) {
        (tg as any).setHeaderColor('#0f0c1b');
      }
      if ((tg as any).setBackgroundColor) {
        (tg as any).setBackgroundColor('#050508');
      }
    }

    const initUser = async () => {
      const unsubscribe = auth.onAuthStateChanged(async (user) => {
        if (!user) {
          try {
            await signInAnonymously(auth);
          } catch (e: any) {
            console.error("Auth Error", e);
            // Fallback to local storage if anon auth fails
            const localGens = localStorage.getItem('localGenerationsLeft');
            if (localGens === null) {
              localStorage.setItem('localGenerationsLeft', '3');
              setGenerationsLeft(3);
            } else {
              setGenerationsLeft(parseInt(localGens, 10));
            }
            setUserId('local-user');
            setInitError(null); // Bypass error to let user try the app
          }
          return;
        }

        const currentUid = user.uid;
        setUserId(currentUid);

        try {
          const userRef = doc(db, 'users', currentUid);
          let userDoc;
          try {
            userDoc = await getDoc(userRef);
          } catch (e: any) {
            console.warn(`getDoc failed: ${e.message || e}.`);
            // Always fallback to local storage if DB fails to initialize properly
            console.warn("Permission denied or DB missing. Falling back to LocalStorage.");
            throw new Error("fallback_to_local");
          }

          if (!userDoc || !userDoc.exists()) {
            const tgUser = tg?.initDataUnsafe?.user;
            try {
              await setDoc(userRef, {
                generationsLeft: 3,
                createdAt: serverTimestamp(),
                ...(tgUser?.id ? { tgId: tgUser.id } : {}),
                ...(tgUser?.username ? { tgUsername: tgUser.username } : {})
              });
              setGenerationsLeft(3);
            } catch (createErr: any) {
              console.warn("setDoc create failed:", createErr?.message || createErr);
              throw new Error("fallback_to_local");
            }
          } else {
            setGenerationsLeft(userDoc.data()?.generationsLeft ?? 0);
          }
        } catch (err: any) {
          if (err.message === "fallback_to_local" || (err.message && err.message.includes("permissions"))) {
            const localGens = localStorage.getItem('localGenerationsLeft');
            if (localGens === null) {
              localStorage.setItem('localGenerationsLeft', '3');
              setGenerationsLeft(3);
            } else {
              setGenerationsLeft(parseInt(localGens, 10));
            }
            setUserId('local-user');
            setInitError(null);
          } else {
            console.error("Firebase Init Error", err);
            // Fallback too to just prevent blocking UI completely if possible
            const localGens = localStorage.getItem('localGenerationsLeft');
            setGenerationsLeft(localGens ? parseInt(localGens, 10) : 3);
            setUserId('local-user');
            setInitError(null);
            setError(`Ошибка инициализации базы данных. Вы используете локальную сессию.`);
          }
        }
      });
      return () => unsubscribe();
    };

    const cleanup = initUser();
    return () => {
      cleanup.then(fn => fn && fn());
    };
  }, []);

  const consumeToken = async () => {
    if (!userId || generationsLeft === null || generationsLeft <= 0) return false;
    
    // Check if we are acting as a local user (either explicitly set or by trying the DB)
    if (userId === 'local-user') {
        const next = generationsLeft - 1;
        setGenerationsLeft(next);
        localStorage.setItem('localGenerationsLeft', next.toString());
        return true;
    }

    try {
      const userRef = doc(db, 'users', userId);
      // Timeout promise to avoid hanging forever if Firebase is disconnected
      await Promise.race([
        updateDoc(userRef, { generationsLeft: increment(-1) }),
        new Promise((_, reject) => setTimeout(() => reject('timeout'), 5000))
      ]);
      setGenerationsLeft(prev => (prev ? prev - 1 : 0));
      return true;
    } catch (err: any) {
      console.warn('Failed to consume token via DB. Falling back to local storage.', err);
      // Fallback
      const next = generationsLeft - 1;
      setGenerationsLeft(next);
      localStorage.setItem('localGenerationsLeft', next.toString());
      return true;
    }
  };

  const checkLimits = async () => {
    return true;
  };

  const [isBuying, setIsBuying] = useState(false);

  const buyTokens = async () => {
    if (!userId) return;
    
    if (userId === 'local-user') {
       alert("Покупка временно недоступна в режиме локальной сессии. Вы можете сбросить браузер, чтобы получить новые.");
       return;
    }

    setIsBuying(true);
    try {
      const response = await fetch('/api/create-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      const data = await response.json();
      if (!response.ok || !data.invoiceUrl) {
        throw new Error(data.error || 'Ошибка при создании счета');
      }

      const tg = window.Telegram?.WebApp;
      if (tg && tg.openInvoice) {
        tg.openInvoice(data.invoiceUrl, async (status: string) => {
          if (status === 'paid') {
            const userRef = doc(db, 'users', userId);
            const snap = await getDoc(userRef);
            if (snap.exists()) {
              await updateDoc(userRef, { generationsLeft: increment(10) });
              setGenerationsLeft(prev => (prev || 0) + 10);
            }
          }
        });
      } else {
        window.open(data.invoiceUrl, '_blank');
      }
    } catch (err: any) {
      console.error("Error creating invoice: ", err);
      alert("Ошибка создания счета: " + (err.message || 'Неизвестная ошибка'));
    } finally {
      setIsBuying(false);
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setResults(null);
    setArGeneratedImageUrl({});
    setTryOnStyle(null);
    setImageUrl(null);
    
    // Check if it's an image
    if (!file.type.startsWith('image/')) {
      setError('Пожалуйста, загрузите изображение (JPEG, PNG).');
      return;
    }

    setMimeType('image/jpeg');
    setIsUploadingImage(true);
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = async () => {
        const MAX_DIM = 800;
        let { width, height } = img;

        if (width > height) {
          if (width > MAX_DIM) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          }
        } else {
          if (height > MAX_DIM) {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        let compressedDataUrl = '';
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          compressedDataUrl = canvas.toDataURL('image/jpeg', 0.82);
        } else {
          compressedDataUrl = event.target?.result as string;
        }

        const b64 = compressedDataUrl.split(',')[1];
        setImageBase64(b64); // Show preview immediately

        try {
          // Send to Firebase Storage in background without blocking
          const fileName = `uploads/${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
          const storageRef = ref(storage, fileName);
          uploadString(storageRef, compressedDataUrl, 'data_url')
            .then(async () => {
              const uploadedUrl = await getDownloadURL(storageRef);
              setImageUrl(uploadedUrl);
            })
            .catch(err => console.error("Firebase Storage Upload Error:", err));
        } catch(err: any) {
          console.error("Firebase Storage Setup Error:", err);
        } finally {
          setIsUploadingImage(false);
        }
      };
      img.onerror = () => {
        setIsUploadingImage(false);
        setError("Ошибка обработки изображения.");
      };
      img.src = event.target?.result as string;
    };
    reader.onerror = () => {
      setIsUploadingImage(false);
      setError("Ошибка чтения файла.");
    };
    reader.readAsDataURL(file);
  };

  const resetApp = () => {
    setImageBase64(null);
    setImageUrl(null);
    setResults(null);
    setMimeType('');
    setError(null);
    setArError(null);
    setArGeneratedImageUrl({});
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (cameraInputRef.current) {
      cameraInputRef.current.value = '';
    }
  };

  const triggerFileInput = (e?: React.MouseEvent) => {
    if (!consentGiven) {
      if (e) {
        e.stopPropagation();
        setConsentError(true);
        if (navigator.vibrate) navigator.vibrate(200);
      }
      return;
    }
    setConsentError(false);
    fileInputRef.current?.click();
  };

  const triggerCameraInput = (e?: React.MouseEvent) => {
    if (!consentGiven) {
      if (e) {
        e.stopPropagation();
        setConsentError(true);
        if (navigator.vibrate) navigator.vibrate(200);
      }
      return;
    }
    setConsentError(false);
    cameraInputRef.current?.click();
  };

  const fallbackFaceApi = async () => {
    try {
      if (!imageBase64) return null;
      const modelsUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
      await Promise.all([
        (window as any).faceapi.nets.ssdMobilenetv1.loadFromUri(modelsUrl),
        (window as any).faceapi.nets.faceLandmark68Net.loadFromUri(modelsUrl),
        (window as any).faceapi.nets.faceExpressionNet.loadFromUri(modelsUrl),
        (window as any).faceapi.nets.ageGenderNet.loadFromUri(modelsUrl)
      ]);
      
      const img = new Image();
      img.src = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;
      await new Promise(resolve => img.onload = resolve);
      
      const detections = await (window as any).faceapi.detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceExpressions()
        .withAgeAndGender();
        
      if (!detections) {
          throw new Error('Лицо не найдено локальным алгоритмом');
      }
      
      return {
        warning: "Лимит обращений к ИИ исчерпан. Мы загрузили для вас базовый набор стрижек (локальный анализ). Для точного персонального анализа — введите собственный бесплатный Gemini API-ключ в настройках хостинга.",
        gender: detections.gender === 'male' ? 'male' : 'female',
        faceShape: "Овальная",
        hairDensity: "Средние",
        hairType: "Прямые",
        ageRange: `${Math.round(detections.age - 5)}-${Math.round(detections.age + 5)}`,
        recommendations: [
          {
            name: "Стрижка Боб (Bob Cut)",
            description: "Классическая длина, которая идет почти всем типам лица.",
            stylingTips: "Слегка подкручивайте концы круглой щеткой для объема.",
            imageKeyword: "Classic Bob Haircut"
          },
          {
            name: "Пикси (Pixie Cut)",
            description: "Смелая короткая стрижка, прекрасно открывает черты лица.",
            stylingTips: "Используйте текстурирующую пасту для создания небрежного вида.",
            imageKeyword: "Textured Pixie Cut"
          },
          {
            name: "Длинные слои (Long Layers)",
            description: "Универсальный способ добавить объем и движение, сохраняя длину.",
            stylingTips: "Легкий спрей с морской солью поможет создать пляжные волны.",
            imageKeyword: "Long Layered Waves"
          }
        ]
      } as AnalysisResult;

    } catch (e) {
      console.error("Local face-api fallback failed", e);
      return null;
    }
  };

  const analyzeImage = async () => {
    if (!imageBase64 && !imageUrl) return;
    
    if (initError) {
      setError(`Сначала необходимо устранить ошибку инициализации: ${initError}`);
      return;
    }

    const proceed = await checkLimits();
    if (!proceed) return;

    setIsAnalyzing(true);
    setError(null);
    
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ imageBase64, imageUrl, mimeType })
      });
      
      if (!response.ok) {
        let errData: any = {};
        try {
           errData = await response.json();
        } catch(e) {}
        
        if (response.status === 429 && errData.fallback) {
           const fallbackResult = await fallbackFaceApi();
           if (fallbackResult) {
              setResults(fallbackResult);
              setIsAnalyzing(false);
              return;
           }
        }
        throw new Error(errData.error || 'Ошибка при анализе фото от сервера.');
      }
      
      const parsedResults = await response.json() as AnalysisResult;
      setResults(parsedResults);

    } catch (err: any) {
      console.error("AI Analysis Error:", err);
      setError(err?.message || "Произошла ошибка при анализе фото. Убедитесь, что лицо четко видно.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const generateARPreview = async (styleKeyword: string, styleName: string) => {
    if (!imageBase64 && !imageUrl) return;
    
    const proceed = await checkLimits();
    if (!proceed) return;

    setIsGeneratingAR(true);
    setArError(null);
    
    try {
      const response = await fetch('/api/generate-ar', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          imageBase64, 
          imageUrl, 
          mimeType, 
          styleKeyword, 
          styleName,
          gender: results?.gender || "unknown",
        })
      });
      
      if (!response.ok) {
        let errData: any = {};
        try { errData = await response.json(); } catch(e) {}
        throw new Error(errData.error || 'Ошибка от сервера при генерации примерки.');
      }
      
      const data = await response.json();
      
      if (data.consultationHtml) {
        setStyleConsultations(prev => ({
          ...prev,
          [styleKeyword]: data.consultationHtml
        }));
      }

      if (data.warning) {
        setArError(data.warning);
      }
      
      if (!data.consultationHtml) {
        throw new Error("Не удалось загрузить данные из ответа сервера.");
      }

    } catch (err: any) {
      console.error("AR Generation Error:", err);
      // We still map what we can locally if network fails entirely
      setStyleConsultations(prev => ({
        ...prev,
        [styleKeyword]: `<div class="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-2 text-sm text-red-200">Сбой генерации гайда. Используйте визуальный референс для мастера.</div>`
      }));
      setArError(err?.message || "Ошибка генерации примерки. Попробуйте снова чуть позже.");
    } finally {
      setIsGeneratingAR(false);
    }
  };

  const loadMoreRecommendations = async () => {
    if ((!imageBase64 && !imageUrl) || !results) return;
    
    const proceed = await checkLimits();
    if (!proceed) return;

    setIsLoadingMore(true);
    setError(null);
    
    const existingNames = results.recommendations.map(r => r.name).join(', ');
    
    try {
      const response = await fetch('/api/load-more', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ imageBase64, imageUrl, mimeType: mimeType || "image/jpeg", existingNames })
      });
      
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Ошибка при генерации новых вариантов от сервера.');
      }
      
      const data = await response.json();
      
      if (data.recommendations) {
        setResults(prev => prev ? {
          ...prev,
          recommendations: [...prev.recommendations, ...data.recommendations]
        } : prev);
      } else {
        throw new Error('Модель не вернула результат.');
      }

    } catch (err: any) {
      console.error("AI Load More Error:", err);
      setError(err?.message || "Ошибка при генерации новых вариантов.");
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050508] text-white/90 font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-white/10 glass-header backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 glass-button rounded-full flex items-center justify-center text-white/90 shadow-[0_8px_32px_rgba(0,0,0,0.37)] border border-white/20">
              <Scissors size={20} className="opacity-90" />
            </div>
            <h1 className="font-serif font-semibold text-2xl tracking-tight text-white/90">НейроСтилист <span className="text-white/60 italic opacity-80">AI</span></h1>
          </div>
          <div className="flex flex-col items-end gap-1">
            <p className="text-xs tracking-[0.2em] text-white/60 uppercase font-medium">ИИ-Подбор Причесок</p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 md:py-16">
        
        {/* Intro */}
        {!imageBase64 && (
           <div className="text-center max-w-2xl mx-auto mb-10 md:mb-16 animate-in fade-in slide-in-from-bottom-8 duration-700">
             <h2 className="font-serif text-3xl sm:text-4xl md:text-5xl lg:text-5xl text-white/90 mb-4 md:mb-6 leading-tight tracking-tight">Какая стрижка подойдет <br className="hidden sm:block" /> <span className="text-white/60 italic">именно вам?</span></h2>
             <p className="text-white/60 leading-relaxed max-w-lg mx-auto font-light text-sm sm:text-base px-2">Загрузите селфи, и наш умный эксперт определит форму вашего лица для подбора стрижек, которые подчеркнут ваши лучшие черты.</p>
           </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-16 items-start">
          
          {/* Left / Top: Upload Zone */}
          <div className={`col-span-1 lg:col-span-5 transition-all duration-700 ${imageBase64 ? '' : 'lg:col-span-8 lg:col-start-3'}`}>
            <div className="relative group">
              
              <div className="relative bg-transparent text-white/90 rounded-2xl border border-white/10 overflow-hidden shadow-sm flex flex-col">
                
                {/* Header of the card */}
                <div className="px-6 py-5 border-b border-white/10 flex justify-between items-center glass-panel">
                  <h3 className="font-medium text-sm tracking-widest uppercase text-white/60 flex items-center gap-2">
                    <Camera size={14} /> ФОТО ПРОФИЛЯ
                  </h3>
                  {imageBase64 && !isAnalyzing && (
                    <button onClick={resetApp} aria-label="Удалить фото и начать заново" className="text-white/60 hover:text-white/90 transition-colors bg-white/5 p-1.5 rounded-full hover:bg-white/10">
                      <X size={16} />
                    </button>
                  )}
                </div>

                <div className="p-2 sm:p-4 pb-6">
                  {!imageBase64 ? (
                    <div className="flex flex-col items-center w-full">
                      <div 
                        className={`w-full border border-dashed rounded-xl glass-panel flex flex-col items-center justify-center min-h-[360px] md:min-h-[440px] relative ${consentError ? 'border-red-500/50 bg-red-500/5' : 'border-white/10 hover:border-white/20'}`}
                      >
                        {consentError && (
                          <div className="absolute top-4 left-0 right-0 flex justify-center animate-pulse">
                            <span className="bg-red-500/20 text-red-100 text-xs px-3 py-1 rounded-full border border-red-500/30 font-medium">
                              Необходимо согласие на обработку данных
                            </span>
                          </div>
                        )}
                        <div className={`w-20 h-20 bg-transparent rounded-full flex items-center justify-center mb-6 shadow-sm border border-white/10 transition-all duration-500 ${consentGiven ? 'text-white/90 hover:scale-105 hover:text-white/90' : 'text-white/40 grayscale'}`}>
                          <Upload size={28} strokeWidth={1.5} />
                        </div>
                        <h4 className="text-xl sm:text-2xl font-serif text-white/90 mb-2 tracking-tight text-center">Загрузите селфи</h4>
                        <p className="text-white/60 text-sm max-w-[280px] text-center mb-8 font-light leading-relaxed px-4">
                          Сделайте фото камерой или выберите из галереи. Лицо должно быть хорошо освещено.
                        </p>
                        
                        <div className="flex flex-col sm:flex-row gap-4 w-full px-6 max-w-[400px]">
                            <button 
                              onClick={triggerCameraInput}
                              className={`flex-1 glass-button text-white/90 border py-3 sm:py-3.5 rounded-full text-[13px] sm:text-sm font-medium tracking-wide transition-all flex items-center justify-center gap-2 ${consentGiven ? 'hover:bg-white/10 border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.37)] active:scale-95' : 'opacity-50 border-white/10 grayscale cursor-not-allowed'}`}
                            >
                              <Camera size={16} />
                              Сделать фото
                            </button>
                            <button 
                              onClick={triggerFileInput}
                              className={`flex-1 glass-button text-white/90 border py-3 sm:py-3.5 rounded-full text-[13px] sm:text-sm font-medium tracking-wide transition-all flex items-center justify-center gap-2 ${consentGiven ? 'hover:bg-white/10 border-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.37)] active:scale-95' : 'opacity-50 border-white/10 grayscale cursor-not-allowed'}`}
                            >
                              <ImageIcon size={16} />
                              Галерея
                            </button>
                        </div>
                        
                        <input 
                          type="file" 
                          accept="image/*" 
                          ref={fileInputRef} 
                          className="hidden" 
                          onChange={handleFileUpload} 
                        />
                        <input 
                          type="file" 
                          accept="image/*" 
                          ref={cameraInputRef} 
                          className="hidden" 
                          onChange={handleFileUpload} 
                        />
                      </div>
                      <div 
                        className="mt-5 flex items-start gap-3 px-2 w-full max-w-[340px] cursor-pointer"
                        onClick={() => {
                          setConsentGiven(!consentGiven);
                          if (!consentGiven) setConsentError(false);
                        }}
                      >
                        <input 
                          type="checkbox" 
                          id="consent152" 
                          checked={consentGiven}
                          onChange={(e) => {
                            // Handled by the wrapper onClick, but keep this for React controlled component warnings
                          }}
                          className="mt-0.5 w-[18px] h-[18px] rounded border-white/20 bg-black/30 text-white/90 accent-[#2AABEE] cursor-pointer flex-shrink-0 pointer-events-none"
                        />
                        <label htmlFor="consent152" className="text-[11px] sm:text-xs text-white/40 leading-relaxed cursor-pointer select-none hover:text-white/60 transition-colors pointer-events-none">
                          Я даю согласие на обработку моих персональных (биометрических) данных в соответствии с ФЗ-152 для обработки селфи нейросетью. Фото не хранится на сервере.
                        </label>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      {/* Preview */}
                      <div className="relative rounded-xl overflow-hidden glass-panel aspect-[3/4] flex items-center justify-center max-h-[500px] ring-1 ring-white/10">
                        <img 
                          src={`data:${mimeType || 'image/jpeg'};base64,${imageBase64}`} 
                          alt="Ваше фото" 
                          className={`max-w-full max-h-full object-contain w-full h-full transition-all duration-1000 ${isAnalyzing ? 'scale-105 blur-sm opacity-50 grayscale hover:grayscale-0' : 'scale-100'}`} 
                        />
                        
                        {/* Scanning Overlay */}
                        {isAnalyzing && (
                          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center">
                            <div className="absolute inset-0 bg-white/10 opacity-20 mix-blend-overlay"></div>
                            <div className="w-full h-1 glass-button opacity-50 shadow-[0_0_20px_#fff] absolute top-[-50%] animate-[scan_2.5s_ease-in-out_infinite_alternate]"></div>
                            <div className="relative z-20 flex flex-col items-center bg-white/5 backdrop-blur-md backdrop-blur-sm p-6 rounded-2xl border border-white/10">
                              <Sparkles className="animate-pulse text-white/90 mb-4" size={32} strokeWidth={1.5}/>
                              <span className="font-serif italic text-white/90 text-xl tracking-wide">Анализ геометрии...</span>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Error Message */}
                      {error && (
                        <div className="bg-red-50 text-red-600 border border-red-100 p-4 rounded-xl text-sm flex items-start gap-3 mt-2">
                          <AlertCircle size={18} className="shrink-0 mt-0.5 opacity-80" />
                          <p className="leading-relaxed">{error}</p>
                        </div>
                      )}

                      {/* Action Button */}
                      {!results && !error && (
                        <button 
                          onClick={analyzeImage}
                          disabled={isAnalyzing || isUploadingImage}
                          className={`w-full font-medium py-4 sm:py-4 px-6 flex items-center justify-center gap-3 transition-all duration-500 uppercase tracking-widest text-[11px] sm:text-xs ${
                            isAnalyzing || isUploadingImage
                              ? 'bg-white/10 text-white/40 border-transparent cursor-not-allowed rounded-full' 
                              : 'glass-button text-white/90 hover:bg-white/10 rounded-full shadow-[0_8px_32px_rgba(0,0,0,0.37)] border border-white/20 focus:ring-4 focus:ring-blue-500/50 active:scale-[0.98]'
                          }`}
                        >
                          {isUploadingImage ? 'Обработка фото...' : isAnalyzing ? 'Нейросеть в работе...' : '✨ Найти лучшую стрижку'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right: Results */}
          {results && (
            <div className="col-span-1 lg:col-span-7 flex flex-col gap-6 lg:gap-8 animate-in fade-in slide-in-from-right-12 duration-1000 fill-mode-both">
              
              {results.warning && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-200 px-5 py-4 rounded-2xl flex items-start gap-4">
                  <AlertCircle className="shrink-0 mt-0.5" size={20} />
                  <p className="text-sm leading-relaxed">{results.warning}</p>
                </div>
              )}

              {/* Vitals */}
              <div className="grid grid-cols-3 gap-3 sm:gap-4 lg:gap-6">
                <div className="glass-panel border border-white/10 rounded-2xl p-5 md:p-6 shadow-sm relative overflow-hidden group hover:border-white/10 transition-colors">
                  <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
                  </div>
                  <p className="text-[10px] md:text-xs text-white/60 uppercase tracking-[0.15em] mb-3">Форма лица</p>
                  <p className="font-serif text-xl sm:text-2xl text-white/90 font-medium tracking-tight">{results.faceShape}</p>
                </div>
                
                <div className="glass-panel border border-white/10 rounded-2xl p-5 md:p-6 shadow-sm relative overflow-hidden group hover:border-white/10 transition-colors delay-100">
                  <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3v5h5M16 13H8M16 17H8M10 9H8"/></svg>
                  </div>
                  <p className="text-[10px] md:text-xs text-white/60 uppercase tracking-[0.15em] mb-3">Густота</p>
                  <p className="font-serif text-xl sm:text-2xl text-white/90 font-medium tracking-tight">{results.hairDensity}</p>
                </div>
                
                <div className="glass-panel border border-white/10 rounded-2xl p-5 md:p-6 shadow-sm relative overflow-hidden group hover:border-white/10 transition-colors delay-200">
                  <div className="absolute top-0 right-0 p-4 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                  </div>
                  <p className="text-[10px] md:text-xs text-white/60 uppercase tracking-[0.15em] mb-3">Текстура</p>
                  <p className="font-serif text-xl sm:text-2xl text-white/90 font-medium tracking-tight">{results.hairType}</p>
                </div>
              </div>

              {/* Recommendations */}
              <div className="mt-4">
                <div className="flex items-center gap-4 mb-6">
                  <div className="h-px bg-white/10 flex-1"></div>
                  <h3 className="font-serif text-xl italic text-white/90 px-4">Рекомендации ИИ</h3>
                  <div className="h-px bg-white/10 flex-1"></div>
                </div>
                
                <div className="flex flex-col gap-5 lg:gap-6">
                  {results.recommendations.map((rec, idx) => (
                    <div 
                      key={idx} 
                      className="glass-panel border border-white/10 rounded-2xl overflow-hidden hover:border-white/20 transition-all duration-500 hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)] group flex flex-col sm:flex-row items-stretch"
                      style={{ animationDelay: `${300 + idx * 150}ms` }}
                    >
                      <div className="w-full sm:w-[300px] shrink-0 relative overflow-hidden bg-transparent text-white/90 border-b sm:border-b-0 sm:border-r border-white/10">
                        <div className="w-full aspect-[4/5] relative">
                          <LazyImage 
                            keyword={rec.imageKeyword} 
                            gender={results?.gender || ''}
                            uniqueName={rec.name}
                            description={rec.description}
                            className="absolute inset-0 w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-700 opacity-90" 
                          />
                          <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 to-transparent sm:hidden pointer-events-none z-10"></div>
                          <div className="absolute top-3 left-3 w-8 h-8 rounded-full bg-white/5 backdrop-blur-md backdrop-blur-md flex items-center justify-center text-white/90 text-xs font-medium border border-white/10 z-20 shadow-sm">
                            {idx + 1}
                          </div>
                        </div>
                      </div>
                      <div className="p-6 sm:p-8 space-y-4 flex-1 flex flex-col justify-center">
                        <div>
                          <h4 className="text-2xl font-serif text-white/90 font-medium tracking-tight mb-2 group-hover:text-white/90/80 transition-colors">{rec.name}</h4>
                          <p className="text-white/60 leading-relaxed font-light text-sm sm:text-base">{rec.description}</p>
                        </div>
                        
                        <div className="bg-transparent text-white/90 p-4 rounded-xl border border-white/10 mt-auto group-hover:bg-white/5 transition-colors">
                          <h5 className="text-[10px] uppercase tracking-widest text-white/60 mb-2 font-medium flex items-center gap-2">
                            <Sparkles size={12} /> Совет стилиста
                          </h5>
                          <p className="text-white/90/80 text-sm font-light leading-relaxed">{rec.stylingTips}</p>
                        </div>

                        <button 
                          onClick={() => setTryOnStyle(rec)}
                          className="mt-4 text-white/90 bg-white/5 hover:bg-white/10 border border-white/10 px-6 py-3.5 sm:py-4 rounded-full text-sm font-medium transition-all flex items-center justify-center gap-2 active:scale-95 w-full lg:w-auto self-start"
                        >
                          <Maximize2 size={16} /> Показать парикмахеру (гайд)
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-8 flex justify-center">
                  <button 
                    onClick={loadMoreRecommendations}
                    disabled={isLoadingMore}
                    className="flex items-center gap-2 text-white/90 glass-panel hover:bg-white/5 border border-white/10 rounded-full shadow-[0_8px_32px_rgba(0,0,0,0.37)] px-6 py-4 transition-all font-medium text-sm sm:text-base disabled:opacity-50"
                  >
                    <RefreshCw size={16} className={isLoadingMore ? "animate-spin" : ""} />
                    {isLoadingMore ? 'Поиск вариантов...' : 'Найти другие крутые варианты'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Barber Blueprint Modal */}
      {tryOnStyle && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-white/10 backdrop-blur-md animate-in fade-in duration-300">
          <div className="glass-panel border border-white/10 rounded-3xl w-full max-w-5xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-5 sm:p-6 border-b border-white/10 flex justify-between items-center bg-transparent text-white/90">
              <h3 className="font-serif text-xl sm:text-2xl text-white/90 flex items-center gap-3 tracking-tight">
                <Scissors className="text-white/60" size={24} />
                Детальный гайд для парикмахера
              </h3>
              <button 
                onClick={() => setTryOnStyle(null)}
                aria-label="Закрыть гайд"
                className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white/90 transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6 sm:p-8 flex flex-col lg:flex-row gap-8 overflow-y-auto custom-scrollbar">
              
              {/* Technical Details */}
              <div className="lg:w-1/3 flex flex-col gap-6 order-2 lg:order-1">
                <div>
                   <h4 className="text-2xl font-serif text-white/90 mb-2 tracking-tight">{tryOnStyle.name}</h4>
                   <p className="text-sm font-light text-white/60 leading-relaxed mb-6">
                     Покажите этот экран вашему мастеру для точного воплощения задуманного образа. Эта стрижка подобрана с учетом вашей геометрии лица и текущей структуры волос.
                   </p>
                </div>
                
                <div className="space-y-4">
                  <div className="bg-transparent text-white/90 border border-white/10 rounded-xl p-5">
                    <h5 className="text-[10px] uppercase tracking-widest text-white/60 mb-3 font-medium flex items-center gap-2">
                       <Zap size={14} /> Ключевые зоны
                    </h5>
                    <ul className="space-y-3 text-sm font-light text-white/90/80">
                      <li className="flex gap-2">
                        <span className="text-white/60">•</span>
                        <span><strong>Структура волос:</strong> {results.hairType}, {results.hairDensity.toLowerCase()}</span>
                      </li>
                      <li className="flex gap-2">
                        <span className="text-white/60">•</span>
                        <span><strong>Верхняя зона:</strong> Оставить длину для текстуры, профилировать по необходимости.</span>
                      </li>
                      <li className="flex gap-2">
                        <span className="text-white/60">•</span>
                        <span><strong>Бока и затылок:</strong> Плавный переход (fade) или укорачивание, чтобы подчеркнуть форму лица ({results.faceShape.toLowerCase()}).</span>
                      </li>
                    </ul>
                  </div>

                  <div className="bg-transparent text-white/90 border border-white/10 rounded-xl p-5">
                    <h5 className="text-[10px] uppercase tracking-widest text-white/60 mb-3 font-medium flex items-center gap-2">
                      <Sparkles size={14} /> Стайлинг (для мастера)
                    </h5>
                    <p className="text-sm font-light text-white/90/80 leading-relaxed">
                      {tryOnStyle.stylingTips}
                    </p>
                  </div>
                </div>

                <div className="mt-auto pt-6 border-t border-white/10">
                   <button 
                     onClick={() => setTryOnStyle(null)}
                     className="w-full bg-white/5 text-white/90 font-medium py-4 px-6 rounded-full hover:bg-white/10 transition-colors active:scale-95 text-base"
                   >
                     ✕ Вернуться к вариантам
                   </button>
                </div>
              </div>

              {/* Visual References */}
              <div className="flex-1 lg:pl-8 lg:border-l border-white/10 order-1 lg:order-2">
                <h4 className="text-sm uppercase tracking-widest text-white/60 font-medium mb-6 flex justify-between items-center">
                  <span>Side-by-side визуализация</span>
                </h4>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 h-auto">
                    {/* Original Input */}
                    <div className="relative glass-panel rounded-2xl overflow-hidden border border-white/10 group aspect-[4/5] sm:aspect-auto sm:h-[400px] lg:h-[500px] flex items-center justify-center shadow-sm">
                      <img 
                        src={`data:${mimeType || 'image/jpeg'};base64,${imageBase64}`} 
                        alt="User" 
                        className="absolute inset-0 w-full h-full object-cover sm:object-contain transition-transform duration-700 group-hover:scale-105" 
                      />
                      <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4 bg-gradient-to-t from-black/60 to-transparent">
                        <span className="text-[10px] sm:text-xs text-white uppercase tracking-wider font-medium drop-shadow-md">Ваша база</span>
                        <p className="text-[9px] sm:text-[10px] text-white mt-0.5 sm:mt-1 hidden sm:block drop-shadow-md">Отправная точка стрижки</p>
                      </div>
                    </div>

                    {/* Reference Output */}
                    <div className="relative glass-panel rounded-2xl overflow-hidden border border-white/10 shadow-sm group aspect-[4/5] sm:aspect-auto sm:h-[400px] lg:h-[500px] flex items-center justify-center">
                      <LazyImage 
                        keyword={tryOnStyle.imageKeyword} 
                        gender={results?.gender || ''}
                        uniqueName={tryOnStyle.name}
                        description={tryOnStyle.description}
                        autoLoad={true}
                        className={`absolute inset-0 w-full h-full object-cover sm:object-contain transition-transform duration-700 group-hover:scale-105`}
                      />

                      <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4 bg-gradient-to-t from-black/60 to-transparent">
                        <span className="text-[10px] sm:text-xs text-white uppercase tracking-wider font-medium drop-shadow-md">Целевой стиль</span>
                        <p className="text-[9px] sm:text-[10px] text-white mt-0.5 sm:mt-1 hidden sm:block drop-shadow-md">Референс результата</p>
                      </div>
                    </div>
                </div>

                <div className="mt-6 flex flex-col gap-3">
                  {styleConsultations[tryOnStyle.imageKeyword] && (
                    <div className="mb-4 bg-white/5 border border-white/10 rounded-2xl p-5 text-white/90">
                      <h4 className="flex items-center gap-2 font-medium mb-3 text-sm uppercase tracking-widest text-white/80">
                        <Sparkles size={16} /> Персональный гайд (AI)
                      </h4>
                      <div 
                        className="text-white/90 text-sm font-light leading-relaxed space-y-4 font-sans
                                   [&>strong]:font-medium [&>strong]:text-white 
                                   [&>ul]:list-disc [&>ul]:pl-5 [&>ul>li]:mb-1"
                        dangerouslySetInnerHTML={{ __html: styleConsultations[tryOnStyle.imageKeyword] }} 
                      />
                    </div>
                  )}
                  <button 
                    onClick={() => generateARPreview(tryOnStyle.imageKeyword, tryOnStyle.name)}
                    disabled={isGeneratingAR}
                    className="w-full glass-button hover:bg-white/10 text-white/90 font-medium py-4 px-6 rounded-full transition-all shadow-[0_8px_32px_rgba(0,0,0,0.37)] active:scale-[0.98] flex justify-center items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed border border-white/20 text-sm sm:text-base"
                  >
                    <Sparkles size={18} />
                    {isGeneratingAR ? 'Генерация...' : styleConsultations[tryOnStyle.imageKeyword] ? '🔄 Обновить персональный гайд' : '📝 Сгенерировать персональный гайд'}
                  </button>
                  {arError && (
                    <p className="text-xs text-orange-200/90 bg-orange-500/20 border border-orange-500/30 p-2.5 rounded-lg text-center leading-relaxed">
                      {arError}
                    </p>
                  )}
                </div>
              </div>

            </div>
          </div>
        </div>
      )}



      <style>{`
        @keyframes scan {
          0% { top: -10%; opacity: 0; }
          10% { opacity: 0.8; }
          90% { opacity: 0.8; }
          100% { top: 110%; opacity: 0; }
        }
      `}</style>
    </div>
  );
}


