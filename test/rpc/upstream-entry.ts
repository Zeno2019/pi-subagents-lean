import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import upstream from "../../src/index.ts";
import { wrap } from "./driver.ts";
export default (pi: ExtensionAPI) => wrap(pi, upstream);
