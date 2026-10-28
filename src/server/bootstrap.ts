// Central registration module: both transports (stdio and HTTP) import this
// once so the full tool + prompt set is registered exactly the same way.
//
// Registration happens as side effects at module load — each tool category
// module calls registerTool() when imported; server/prompts.js registers the
// MCP prompts the same way.

import "./prompts.js";
import "../tools/childManagement.js";
import "../tools/sleep.js";
import "../tools/feeding.js";
import "../tools/diaper.js";
import "../tools/growth.js";
import "../tools/solids.js";
