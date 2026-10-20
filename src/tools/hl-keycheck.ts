// Read-only Hyperliquid check. No orders. Prints whether each bee's API wallet is approved, the account mode,
// and USDC equity. Never prints the private key.
// pnpm hl:keycheck
// Talks to testnet unless HL_NETWORK=mainnet. Mainnet also needs HL_KEYCHECK_MAINNET=yes, so a copied setting
// cannot query mainnet by accident.
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { BEES } from "../config.js";
import { HL_WEIGHT, WeightBudget } from "../hl/limit.js";
import { safeError } from "../redact.js";

const env = process.env;
const network = env.HL_NETWORK?.trim() === "mainnet" ? "mainnet" : "testnet";
if (network === "mainnet" && env.HL_KEYCHECK_MAINNET !== "yes") {
  console.log("HL_NETWORK=mainnet. Refusing to contact mainnet. Set HL_KEYCHECK_MAINNET=yes if you mean it. Nothing was sent.");
  process.exit(1);
}

const budget = new WeightBudget();
const client = new InfoClient({ transport: new HttpTransport({ isTestnet: network === "testnet", timeout: 15_000 }) });
let failures = 0;
console.log(`Hyperliquid ${network} (read only)`);

for (const bee of BEES) {
  const p = bee.toUpperCase();
  const infix = network === "testnet" ? "HL_TESTNET" : "HL";
  const account = env[`${p}_${infix}_ACCOUNT`]?.trim();
  const agentKey = env[`${p}_${infix}_AGENT_KEY`]?.trim();
  const tag = bee.padEnd(6);
  if (!account && !agentKey) {
    console.log(`${tag}  not set`);
    continue;
  }
  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account) || !agentKey || !/^0x[0-9a-fA-F]{64}$/.test(agentKey)) {
    failures++;
    console.log(`${tag}  INCOMPLETE (account must be a 0x address and the API wallet key a 0x private key)`);
    continue;
  }
  try {
    const agent = privateKeyToAccount(agentKey as `0x${string}`).address;
    const user = account as `0x${string}`;
    await budget.take(HL_WEIGHT.extraAgents);
    const agents = await client.extraAgents({ user });
    const hit = agents.find((a) => a.address.toLowerCase() === agent.toLowerCase());
    await budget.take(HL_WEIGHT.userAbstraction);
    const mode = await client.userAbstraction({ user });
    await budget.take(HL_WEIGHT.clearinghouseState);
    const state = await client.clearinghouseState({ user });
    const standard = mode === "default" || mode === "disabled";
    const approved = !!hit && (hit.validUntil === null || hit.validUntil > Date.now());
    if (!approved || !standard) failures++;
    const until = !hit || hit.validUntil === null ? "no expiry" : new Date(hit.validUntil).toISOString().slice(0, 10);
    console.log(`${tag}  ${approved ? "API wallet approved" : "API WALLET NOT APPROVED"} · mode ${mode}${standard ? "" : " (switch to Standard)"} · until ${until} · equity ${state.marginSummary.accountValue} USDC`);
  } catch (err) {
    failures++;
    const e = safeError(err);
    console.log(`${tag}  FAILED ${e.code} ${e.message}`);
  }
}

if (failures) {
  console.log(`\n${failures} bee(s) failed the check`);
  process.exit(1);
}
console.log("\nall set bees passed");
