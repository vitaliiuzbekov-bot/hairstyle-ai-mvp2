import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { GoogleGenAI, Type, Modality } from "@google/genai";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import "dotenv/config";

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Middleware for parsing JSON with a larger limit for images
  app.use(express.json({ limit: "50mb" }));

  function getApiKeyFromRequest(req: express.Request): string {
    const rawKey =
      (req.headers["x-custom-api-key"] as string) || req.body?.customApiKey;
    const customKey = rawKey ? rawKey.trim() : "";

    // If user provided a specific API key, use it
    if (customKey && customKey.startsWith("AIzaSy")) {
      return customKey;
    }

    const envKey = process.env.GEMINI_API_KEY || process.env.API_KEY || "";
    if (envKey && envKey.startsWith("AIzaSy")) {
      return envKey;
    }

    return "";
  }

  // Define a retry wrapper for Google Gen AI calls
  async function generateWithRetry(
    generateFn: () => Promise<any>,
    maxRetries = 3,
  ) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await generateFn();
      } catch (err: any) {
        lastError = err;
        const errorMsg = String(err.message || "");
        if (
          errorMsg.includes("quota") ||
          errorMsg.includes("RESOURCE_EXHAUSTED") ||
          errorMsg.includes("limit: 0") ||
          errorMsg.includes("API_KEY_INVALID") ||
          errorMsg.includes("API key not valid")
        ) {
          // Do not retry these definitive errors
          throw err;
        }

        if (
          errorMsg.includes("503") ||
          errorMsg.includes("high demand") ||
          errorMsg.includes("UNAVAILABLE") ||
          errorMsg.includes("429")
        ) {
          console.log(
            `[Retry ${i + 1}/${maxRetries}] Encountered rate limit or 503, waiting before retry...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  // Rate Limiter to prevent bankruptcy from GenAI usage overhead
  const apiLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 15, // limit each IP to 15 requests per windowMs
    message: { error: "Суточный бесплатный лимит запросов исчерпан. Введите свой API-ключ в настройках хостинга." },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      // If user provided a valid custom API key, they don't count towards the free rate limit
      const rawKey = (req.headers["x-custom-api-key"] as string) || req.body?.customApiKey;
      return !!(rawKey && rawKey.trim().startsWith("AIzaSy"));
    }
  });

  app.use("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/analyze", apiLimiter);
  app.use("/api/generate-ar", apiLimiter);
  app.use("/api/load-more", apiLimiter);

  // API Routes
  
  async function fetchImageAsBase64(url: string | null, fallbackBase64: string | null): Promise<string | null> {
    if (!url && !fallbackBase64) return null;
    if (url) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
        const fetchRes = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (fetchRes.ok) {
          const buffer = await fetchRes.arrayBuffer();
          return Buffer.from(buffer).toString('base64');
        }
      } catch (e) {
        console.error("Failed to fetch image from URL:", e);
      }
    }
    return fallbackBase64;
  }

  app.post("/api/analyze", async (req, res) => {
    try {
      const apiKey = getApiKeyFromRequest(req);
      if (!apiKey) {
        return res.status(401).json({ error: "API-ключ не настроен. Пожалуйста, введите свой API-ключ в настройках хостинга." });
      }
      const ai = new GoogleGenAI({ apiKey });
      const { imageBase64, imageUrl, mimeType } = req.body;
      
      const targetBase64 = await fetchImageAsBase64(imageUrl, imageBase64);
      if (!targetBase64) {
        return res.status(400).json({ error: "No image provided" });
      }

      const response = await generateWithRetry(() =>
        ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: {
            parts: [
              {
                text: "Ты элитный парикмахер-стилист. Внимательно изучи фото.\n\nШАГ 1. Оцени ПОЛ человека на фото (male/female).\nШАГ 2. Оцени текущую ДЛИНУ волос, ЦВЕТ ВОЛОС (точный оттенок на Английском), ГУСТОТУ (hair density).\nШАГ 3. Оцени ТОН КОЖИ на Английском (fair with freckles, light olive, medium warm, etc.), ДЕТАЛИ КОЖИ (freckles/moles/clear), ЦВЕТ ГЛАЗ (blue/green/brown/hazel/grey).\nШАГ 4. Оцени ВОЗРАСТ (20-30, 30-40, etc.) и ОСОБЕННОСТИ ЛИЦА (strong jawline, high cheekbones, etc.).\nШАГ 5. Предложи 3 СОВЕРШЕННО РАЗНЫЕ оптимальные стрижки.\n\nАБСОЛЮТНОЕ ПРАВИЛО 1: Описание стрижек строго на русском языке.\nАБСОЛЮТНОЕ ПРАВИЛО 2: ЗАПРЕЩЕНО предлагать стрижки, для которых нужны волосы длиннее, чем есть на фото! Если волосы короткие - предлагать только короткие стрижки. Если волосы редкие - не предлагать объемные прически.\nАБСОЛЮТНОЕ ПРАВИЛО 3: Все 3 стрижки должны кардинально отличаться друг от друга по стилю.\nАБСОЛЮТНОЕ ПРАВИЛО 4: В поле imageKeyword ОБЯЗАТЕЛЬНО укажи густоту волос клиента на английском языке.\n\nВ поле imageKeyword укажи профессиональное название стрижки И описание густоты НА АНГЛИЙСКОМ (например: textured french crop, thin fine hair).",
              },
              {
                inlineData: {
                  data: targetBase64,
                  mimeType: mimeType || "image/jpeg",
                },
              },
            ],
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                gender: {
                  type: Type.STRING,
                  description: "Пол человека на фото: 'male' или 'female'",
                },
                faceShape: {
                  type: Type.STRING,
                  description: "Форма лица (овальная, круглая, квадратная и т.д.)",
                },
                 hairDensity: {
                  type: Type.STRING,
                  description: "Например: Густые, Тонкие, Средние",
                },
                hairType: {
                  type: Type.STRING,
                  description: "Например: Прямые, Волнистые, Кудрявые",
                },
                skinTone: {
                  type: Type.STRING,
                  description: "Тон кожи на английском (например: light olive, fair, dark)",
                },
                skinDetails: {
                  type: Type.STRING,
                  description: "Детали кожи (freckles, clear, moles)",
                },
                hairColor: {
                  type: Type.STRING,
                  description: "Точный оттенок волос на английском (ash blonde, honey brown, jet black)",
                },
                eyeColor: {
                  type: Type.STRING,
                  description: "Цвет глаз на английском (blue, green, brown, hazel)",
                },
                ageRange: {
                  type: Type.STRING,
                  description: "Примерный возраст (например: 20-30)",
                },
                facialFeatures: {
                  type: Type.STRING,
                  description: "Особенности лица на английском (strong jawline, soft features)",
                },
                recommendations: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: {
                        type: Type.STRING,
                        description: "Название современной стрижки",
                      },
                      description: {
                        type: Type.STRING,
                        description: "Почему это подходит данному типу лица",
                      },
                      stylingTips: {
                        type: Type.STRING,
                        description:
                          "Советы по укладке (какие стайлинги использовать)",
                      },
                      imageKeyword: {
                        type: Type.STRING,
                        description:
                          "Точное профессиональное название стрижки на английском языке для генерации фото",
                      },
                    },
                    required: [
                      "name",
                      "description",
                      "stylingTips",
                      "imageKeyword",
                    ],
                  },
                },
              },
              required: [
                "faceShape",
                "hairDensity",
                "hairType",
                "recommendations",
              ],
            },
          },
        }),
      );

      const jsonStr = response.text?.trim();
      res.json(JSON.parse(jsonStr || "{}"));
    } catch (err: any) {
      console.error(err);

      let errorMsg = err.message || "Ошибка при анализе фото";
      if (typeof errorMsg === "string" && errorMsg.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(errorMsg);
          errorMsg = parsed.error?.message || errorMsg;
        } catch(e) {}
      }
      if (typeof errorMsg === "object") errorMsg = JSON.stringify(errorMsg);
      if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("API key not valid") || errorMsg.includes("API_KEY_INVALID"))
      ) {
        errorMsg = "Неверный API-ключ Gemini. Проверьте настройки (⚙️).";
      } else if (
        typeof errorMsg === "string" && 
        errorMsg.includes("API key expired")
      ) {
        errorMsg = "Срок действия встроенного API-ключа истек. Пожалуйста, обновите рабочий ключ в настройках хостинга или в переменных окружения хостинга (Render).";
      } else if (
        typeof errorMsg === "string" &&
        errorMsg.includes("leaked")
      ) {
        errorMsg = "Ваш API-ключ заблокирован Google (так как попал в открытый доступ). Пожалуйста, удалите его и создайте новый в Google AI Studio.";
      } else if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("429") ||
          errorMsg.includes("quota") ||
          errorMsg.includes("RESOURCE_EXHAUSTED"))
      ) {
         return res.status(429).json({ success: false, error: 'QUOTA_EXCEEDED', fallback: true });
      } else if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("503") ||
          errorMsg.includes("high demand") ||
          errorMsg.includes("UNAVAILABLE") ||
          errorMsg.includes("overloaded"))
      ) {
        errorMsg = "Сервер перегружен (503). Повторите попытку.";
      }

      res.status(500).json({ error: errorMsg });
    }
  });

  app.post("/api/generate-reference", async (req, res) => {
    try {
      const { gender, keyword, faceShape, hairDensity, hairType, skinTone, skinDetails, hairColor, eyeColor, ageRange, facialFeatures } = req.body;
      const hfToken = req.headers['x-hf-token'];
      if (!keyword) {
        return res.status(400).json({ error: "Missing parameters" });
      }

      let descriptor = 'fashion model';
      const g = (gender || '').toLowerCase().trim();
      if (g === 'male' || g.includes('муж') || g.includes('man') || g.includes('boy')) {
        descriptor = 'handsome young man';
      } else if (g === 'female' || g.includes('жен') || g.includes('woman') || g.includes('girl')) {
        descriptor = 'beautiful young woman';
      }

      const features = [];
      if (ageRange && ageRange.length > 2) features.push(`${ageRange} years old`);
      if (faceShape && faceShape.length > 2) features.push(`${faceShape} face shape`);
      if (skinTone && skinTone.length > 2) features.push(`${skinTone} skin`);
      if (skinDetails && !skinDetails.toLowerCase().includes('clear') && skinDetails.length > 2) features.push(`with ${skinDetails}`);
      if (eyeColor && eyeColor.length > 2) features.push(`${eyeColor} eyes`);
      if (facialFeatures && facialFeatures.length > 2) features.push(`featuring ${facialFeatures}`);
      
      const detailedFeatures = features.length > 0 ? `, ${features.join(', ')}` : '';
      
      const prompt = `High-end editorial portrait of a ${descriptor}${detailedFeatures}, modeling a photorealistic haircut, style exactly matching "${keyword}", ${hairColor ? `${hairColor} hair, ` : ''}${hairType ? `${hairType} texture, ` : ''}${hairDensity ? `${hairDensity} density, ` : ''}professional salon photography, studio lighting, hyper-realistic hair texture, trending on pinterest, 8k resolution`;

      let finalImageUrl = "";
      let lastError = "";

      // Fallback 1: Pollinations
      const seed = Math.floor(Math.random() * 10000000);
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${seed}`;
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
           const errText = await response.text();
           console.error("Pollinations error response:", response.status, errText);
           throw new Error(`Не удалось сгенерировать изображение (Status ${response.status}).`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        finalImageUrl = `data:image/jpeg;base64,${base64}`;
      } catch (err: any) {
        console.error("Reference gen fetch error:", err);
        lastError += ` [Pollinations: ${err.message}]`;
      }

      // Fallback 2: HuggingFace Text-To-Image
      if (!finalImageUrl) {
          const activeHfToken = hfToken || process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
          if (activeHfToken) {
              try {
                  console.log("Trying HuggingFace (FLUX) for reference...");
                  const hfRes = await fetch("https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell", {
                      method: "POST",
                      headers: {
                          "Authorization": `Bearer ${activeHfToken}`,
                          "Content-Type": "application/json"
                      },
                      body: JSON.stringify({ inputs: prompt })
                  });
                  if (hfRes.ok) {
                      const hfBlob = await hfRes.arrayBuffer();
                      const hfB64 = Buffer.from(hfBlob).toString("base64");
                      finalImageUrl = `data:image/jpeg;base64,${hfB64}`;
                  } else {
                      const errText = await hfRes.text();
                      lastError += ` [HF: ${errText}]`;
                  }
              } catch(err: any) {
                  lastError += ` [HF Err: ${err.message}]`;
              }
          } else {
              lastError += ` [HF: Token not provided]`;
          }
      }

      if (!finalImageUrl) {
          console.error(`Не удалось сгенерировать изображение: ${lastError}. Используем fallback-изображение.`);
          // If all AI generation fails, return a high-quality stock photo so the UI doesn't break
          finalImageUrl = 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80';
      }

      res.json({ imageUrl: finalImageUrl });
    } catch (err: any) {
      console.error("Reference gen error:", err);
      res.status(500).json({ error: err.message || "Ошибка генерации референса" });
    }
  });

  app.post("/api/generate-ar", async (req, res) => {
    try {
      const apiKey = getApiKeyFromRequest(req);
      if (!apiKey) {
        return res.status(401).json({ error: "API-ключ не настроен. Пожалуйста, введите свой API-ключ в настройках хостинга." });
      }
      const ai = new GoogleGenAI({ apiKey });
      const { imageBase64, imageUrl, mimeType, styleKeyword, styleName } = req.body;
      const targetBase64 = await fetchImageAsBase64(imageUrl, imageBase64);
      if (!targetBase64 || !styleKeyword || !styleName) {
        return res.status(400).json({ error: "Missing parameters" });
      }

      console.log("Generating text consultation for AR try-on feature...");
      
      const textRes = await generateWithRetry(() =>
        ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: {
              parts: [
                {
                  inlineData: {
                    data: targetBase64,
                    mimeType: mimeType || "image/jpeg",
                  },
                },
                {
                  text: `Проанализируй лицо человека на фото.
Подробно объясни, как стрижка "${styleKeyword}" (${styleName}) будет смотреться на этом конкретном человеке. Напиши 3 пункта: 
- "Персональный анализ": Почему это подойдет или какие нужны адаптации под форму лица.
- "Как просить мастера": Конкретные инструкции для барбера/парикмахера.
- "Уход и укладка": Какие средства использовать каждый день.
Форматируй текст СТРОГО с помощью HTML-тегов (<p>, <strong>, <br>, <ul>, <li>).
НЕ используй синтаксис markdown. Верни ТОЛЬКО готовый HTML код.`,
                },
              ],
            },
          })
      );

      let consultationHtml = "<p>Консультация недоступна.</p>";
      let text = "";
      try {
           text = textRes.text?.trim() || "";
      } catch (getTextErr) {
           console.error("Could not read textRes.text:", getTextErr);
      }

      if (text) {
           text = text.replace(/```html\s*/g, "").replace(/```\s*$/g, "").trim();
           consultationHtml = text;
      } else {
           consultationHtml = `<p>Консультация сгенерировала пустой ответ. Возможно, загруженное фото не позволяет провести анализ.</p>`;
      }
        
      return res.json({ 
        consultationHtml,
        warning: ""
      });
    } catch (err: any) {
      console.error(err);
      let errorMsg = err.message || "Ошибка генерации примерки";
      if (typeof errorMsg === "string" && errorMsg.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(errorMsg);
          errorMsg = parsed.error?.message || errorMsg;
        } catch(e) {}
      }
      if (typeof errorMsg === "object") errorMsg = JSON.stringify(errorMsg);

      if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("API key not valid") || errorMsg.includes("API_KEY_INVALID"))
      ) {
        errorMsg = "Неверный API-ключ Gemini. Проверьте настройки (⚙️).";
      } else if (
        typeof errorMsg === "string" && 
        errorMsg.includes("API key expired")
      ) {
        errorMsg = "Срок действия встроенного API-ключа истек. Пожалуйста, обновите рабочий ключ в настройках хостинга или в переменных окружения хостинга (Render).";
      } else if (
        typeof errorMsg === "string" &&
        errorMsg.includes("leaked")
      ) {
        errorMsg = "Ваш API-ключ заблокирован Google (так как попал в открытый доступ). Пожалуйста, удалите его и создайте новый в Google AI Studio.";
      } else if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("429") ||
          errorMsg.includes("quota") ||
          errorMsg.includes("RESOURCE_EXHAUSTED") ||
          errorMsg.includes("limit: 0"))
      ) {
        errorMsg =
          "Бесплатная квота исчерпана (429) или ключ только создан (подождите пару минут). Укажите свой собственный рабочий API ключ (с поддержкой gemini-2.5-flash-image) в настройках хостинга или привяжите биллинг.";
      } else if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("503") ||
          errorMsg.includes("high demand") ||
          errorMsg.includes("UNAVAILABLE") ||
          errorMsg.includes("overloaded"))
      ) {
        errorMsg = "Сервер перегружен (503). Повторите попытку.";
      }
      res.status(500).json({ error: errorMsg });
    }
  });

  app.post("/api/load-more", async (req, res) => {
    try {
      const apiKey = getApiKeyFromRequest(req);
      if (!apiKey) {
        return res.status(401).json({ error: "API-ключ не настроен. Пожалуйста, введите свой API-ключ в настройках хостинга." });
      }
      const ai = new GoogleGenAI({ apiKey });
      const { imageBase64, imageUrl, mimeType, existingNames } = req.body;
      const targetBase64 = await fetchImageAsBase64(imageUrl, imageBase64);

      const response = await generateWithRetry(() =>
        ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: {
            parts: [
              {
                text: `Ты элитный парикмахер-стилист. Внимательно изучи фото.\n\nШАГ 1. Оцени ПОЛ (male/female), текущую ДЛИНУ волос и ГУСТОТУ (hair density).\nШАГ 2. Предложи 3 НОВЫЕ СОВЕРШЕННО РАЗНЫЕ стрижки.\n\nАБСОЛЮТНОЕ ПРАВИЛО 1: Описание строго на русском языке.\nАБСОЛЮТНОЕ ПРАВИЛО 2: ЗАПРЕЩЕНО предлагать стрижки, для которых нужны волосы длиннее, чем есть на фото! Если волосы короткие - только короткие.\nАБСОЛЮТНОЕ ПРАВИЛО 3: Исключить следующие стрижки, они уже были предложены: ${existingNames}.\nАБСОЛЮТНОЕ ПРАВИЛО 4: Все 3 стрижки должны кардинально отличаться друг от друга.\nАБСОЛЮТНОЕ ПРАВИЛО 5: В поле imageKeyword ОБЯЗАТЕЛЬНО укажи густоту волос на английском языке (например: thin sparse hair, thick hair), чтобы референсы совпадали с объемом волос оригинала.\n\nВ поле imageKeyword укажи профессиональное название стрижки И густоту НА АНГЛИЙСКОМ (например: textured french crop, thin fine hair).`,
              },
              {
                inlineData: {
                  data: targetBase64 || "",
                  mimeType: mimeType || "image/jpeg",
                },
              },
            ],
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                recommendations: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING },
                      description: { type: Type.STRING },
                      stylingTips: { type: Type.STRING },
                      imageKeyword: {
                        type: Type.STRING,
                        description:
                          "Точное профессиональное название стрижки на английском языке для генерации фото",
                      },
                    },
                    required: [
                      "name",
                      "description",
                      "stylingTips",
                      "imageKeyword",
                    ],
                  },
                },
              },
              required: ["recommendations"],
            },
          },
        }),
      );

      const jsonStr = response.text?.trim();
      res.json(JSON.parse(jsonStr || "{}"));
    } catch (err: any) {
      console.error(err);
      let errorMsg = err.message || "Ошибка генерации новых вариантов";
      if (typeof errorMsg === "string" && errorMsg.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(errorMsg);
          errorMsg = parsed.error?.message || errorMsg;
        } catch(e) {}
      }
      if (typeof errorMsg === "object") errorMsg = JSON.stringify(errorMsg);
      if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("API key not valid") || errorMsg.includes("API_KEY_INVALID"))
      ) {
        errorMsg = "Неверный API-ключ Gemini. Проверьте настройки (⚙️).";
      } else if (
        typeof errorMsg === "string" && 
        errorMsg.includes("API key expired")
      ) {
        errorMsg = "Срок действия встроенного API-ключа истек. Пожалуйста, обновите рабочий ключ в настройках хостинга или в переменных окружения хостинга (Render).";
      } else if (
        typeof errorMsg === "string" &&
        errorMsg.includes("leaked")
      ) {
        errorMsg = "Ваш API-ключ заблокирован Google (так как попал в открытый доступ). Пожалуйста, удалите его и создайте новый в Google AI Studio.";
      } else if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("429") ||
          errorMsg.includes("quota") ||
          errorMsg.includes("RESOURCE_EXHAUSTED"))
      ) {
        return res.status(200).json({
          recommendations: [
            {
              name: "Гарсон (Garcon)",
              description: "Короткая французская стрижка с легким объемом на макушке.",
              stylingTips: "Используйте мусс для объема перед сушкой.",
              imageKeyword: "Garcon haircut"
            },
            {
              name: "Каре на ножке",
              description: "Стильный вариант боба с открытым затылком.",
              stylingTips: "Слегка вытягивайте утюжком для гладкости.",
              imageKeyword: "A-line bob"
            }
          ]
        });
      } else if (
        typeof errorMsg === "string" &&
        (errorMsg.includes("503") ||
          errorMsg.includes("high demand") ||
          errorMsg.includes("UNAVAILABLE") ||
          errorMsg.includes("overloaded"))
      ) {
        errorMsg = "Сервер перегружен (503). Повторите попытку.";
      }
      res.status(500).json({ error: errorMsg });
    }
  });

  app.post("/api/create-invoice", async (req, res) => {
    try {
      const { userId } = req.body;
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) {
        return res
          .status(500)
          .json({ error: "Telegram Bot Token is not configured" });
      }

      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/createInvoiceLink`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Генерации нейростилиста",
            description: "Пакет 10 генераций",
            payload: JSON.stringify({ userId, package: 10 }),
            provider_token: "", // Empty for Telegram Stars
            currency: "XTR",
            prices: [{ label: "10 генераций", amount: 50 }], // 50 Stars
          }),
        },
      );

      const data = await response.json();
      if (data.ok) {
        res.json({ invoiceUrl: data.result });
      } else {
        res
          .status(400)
          .json({ error: data.description || "Failed to create invoice" });
      }
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });



  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    
    // Add fallback for dev mode to serve index.html
    const fs = await import("fs");
    app.use("*", async (req, res, next) => {
      try {
        const url = req.originalUrl;
        let template = fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf-8");
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(template);
      } catch (e: any) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
