import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { isVerbose, isYes } from "../globals.js";

export async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  // Simple Y/N prompt honoring global --yes and verbosity flags.
  if (isVerbose() && isYes()) {
    return true;
  } // redundant guard when both flags set
  if (isYes()) {
    return true;
  }
  const rl = readline.createInterface({ input, output });
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
  rl.close();
  if (!answer) {
    return defaultYes;
  }
  return answer.startsWith("y");
}

export async function promptQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question(`${question} `)).trim();
  rl.close();
  return answer;
}

export async function promptMultiline(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  console.log(`${question} (Press Ctrl+D or type 'EOF' on a new line to finish)`);
  let answer = "";
  for await (const line of rl) {
    if (line.trim() === "EOF") {
      break;
    }
    answer += line + "\n";
  }
  rl.close();
  return answer.trim();
}
