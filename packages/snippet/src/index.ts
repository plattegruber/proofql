// Entry point of dist/v1.js: everything is inside one guard so a bug here can
// never surface as an exception on the host page.
import { boot, debug } from "./snippet.js";

try {
  boot(window);
} catch (error) {
  debug("failed to start", error);
}
