import { handleMentorTrade } from "./_handlers.js";

// Large fan-outs chain across hops; each hop needs enough time for a batch.
export const config = { maxDuration: 120 };

export default handleMentorTrade;
