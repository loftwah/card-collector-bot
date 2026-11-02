import type { APIRoute } from "astro";
import { base32, newId } from "../../server/ids";
export const GET: APIRoute = async () => {
  const a = crypto.getRandomValues(new Uint8Array(10));
  return Response.json({
    bytes: Array.from(a),
    base32: base32(a),
    directBase32: base32(new Uint8Array([1,2,3,4,5,6,7,8,9,10])),
    ids: [newId("x"), newId("x")],
  });
};
