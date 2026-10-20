import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lean from "../../src/lean.ts";
import { wrap } from "./driver.ts";
export default (pi: ExtensionAPI) => wrap(pi, lean);
