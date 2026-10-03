import { handleConnect } from "./_handlers.js";

// Background ConnectEx via waitUntil — needs the full Pro duration window.
export const config = { maxDuration: 300 };

export default handleConnect;
