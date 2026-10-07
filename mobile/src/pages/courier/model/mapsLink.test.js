import { mapsUrl } from "./mapsLink";

describe("mapsUrl", () => {
  test("gera URL de busca", () => {
    const url = mapsUrl("Rua A, 123, Centro");
    expect(url).toContain("google.com/maps/search");
    expect(url).toContain("query=");
    expect(url).toContain("Rua%20A%2C%20123%2C%20Centro");
  });

  test("retorna null para vazio", () => {
    expect(mapsUrl("")).toBeNull();
    expect(mapsUrl(null)).toBeNull();
  });
});
