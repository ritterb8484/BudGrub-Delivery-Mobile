import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

/**
 * Evidence photo (sealed load, fuel receipt). Returned as base64 for the queued event and the temporary file is deleted
 * straight away; the event body drops the image once the server acknowledges it. Never used for ID documents.
 */
export async function takeEvidencePhoto(): Promise<{ mime: string; dataBase64: string; previewUri: string } | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Camera permission is needed to take the photo.");
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.4, base64: true, exif: false, allowsEditing: false });
  if (r.canceled || !r.assets[0]?.base64) return null;
  const a = r.assets[0];
  const out = { mime: a.mimeType ?? "image/jpeg", dataBase64: a.base64!, previewUri: `data:${a.mimeType ?? "image/jpeg"};base64,${a.base64}` };
  try {
    new File(a.uri).delete();
  } catch {
    /* already gone */
  }
  return out;
}
