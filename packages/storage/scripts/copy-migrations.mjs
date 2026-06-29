import { cp, rm } from "node:fs/promises";

await rm("dist/migrations", { recursive: true, force: true });
await cp("src/migrations", "dist/migrations", { recursive: true });
