import { request } from "@/shared/api/http";

export async function postCourierLocation({ latitude, longitude, accuracy }) {
  if (latitude == null || longitude == null) return null;
  try {
    const res = await request("/courier/location", {
      method: "POST",
      json: {
        latitude: Number(latitude),
        longitude: Number(longitude),
        accuracy: accuracy == null ? undefined : Number(accuracy),
      },
    });
    return res;
  } catch {
    // Erro engolido conforme contrato
    return null;
  }
}
