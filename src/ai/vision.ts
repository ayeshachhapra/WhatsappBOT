import { config } from "../config";
import { getGeminiClient, getResponseText, buildGenerationConfig } from "./gemini";
import createLogger from "../utils/logger";

const log = createLogger("Vision");

const VISION_PROMPT = `You are extracting useful information from an image shared in a supply-chain WhatsApp group.

The image is most likely one of: an invoice, dispatch/delivery slip, packing list, e-way bill, POD photo, AWB / shipping label, screenshot of a tracking page, or a photo of items.

Extract a single plain-text block that:
1. Reproduces ALL human-readable text visible in the image, in natural reading order.
2. Highlights at the top, on a single line each (only if the value is clearly visible):
   - PO Number: ...
   - Invoice Number: ...
   - AWB / Tracking Number: ...
   - Container / Vehicle Number: ...
   - Date(s): ...
   - Amount / Total: ...
   - Items / Quantity: ...

If the image has NO usable text (just a product photo, blurry image, etc.), describe what is shown in 1-2 sentences instead.

Plain text output only — no markdown, no commentary.`;

export interface VisionResult {
  text: string;
  ms: number;
}

export async function ocrImage(
  bytes: Buffer,
  mimeType: string,
  caption?: string | null
): Promise<VisionResult> {
  const start = Date.now();
  const client = getGeminiClient();
  const model = client.getGenerativeModel({
    model: config.geminiModel,
    generationConfig: buildGenerationConfig({ temperature: 0.1 }),
  });

  const captionLine = caption && caption.trim()
    ? `\nA caption was attached to the image: "${caption.trim()}"\n`
    : "";

  try {
    const result = await Promise.race([
      model.generateContent([
        { inlineData: { data: bytes.toString("base64"), mimeType } },
        { text: VISION_PROMPT + captionLine },
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Vision OCR timed out after 35s")),
          35_000
        )
      ),
    ]);
    let text = getResponseText((result as any).response).trim();
    if (text.length > 4000) text = text.slice(0, 4000);
    const ms = Date.now() - start;
    log.info(`OCR done in ${ms}ms (${text.length} chars, mime=${mimeType})`);
    return { text, ms };
  } catch (err: any) {
    log.warn(`OCR failed: ${err.message}`);
    return { text: caption || "", ms: Date.now() - start };
  }
}
