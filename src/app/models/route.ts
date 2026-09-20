// GET /models —— 裸路径变体（原版 path.endsWith("/models") 同时匹配 /v1/models 与 /models）。
export { GET, dynamic } from "../v1/models/route";
