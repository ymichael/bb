
import type { ImageDetail } from "./ImageDetail.js";

export type FunctionCallOutputContentItem = { "type": "input_text", text: string, } | { "type": "input_image", image_url: string, detail?: ImageDetail, } | { "type": "input_audio", audio_url: string, } | { "type": "encrypted_content", encrypted_content: string, };
