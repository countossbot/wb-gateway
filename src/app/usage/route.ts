// GET /usage —— 裸路径变体（原版 path.endsWith("/usage") 同时匹配 /v1/usage 与 /usage）。
export { GET } from "../v1/usage/route";

export const dynamic = "force-dynamic";
