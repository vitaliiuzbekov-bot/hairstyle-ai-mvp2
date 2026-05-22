import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function test() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Generate a picture of a cat",
      config: { responseModalities: ["IMAGE"] }
    });
    console.log("Success:", !!response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data);
  } catch (err) {
    console.error("Error:", err);
  }
}
test();