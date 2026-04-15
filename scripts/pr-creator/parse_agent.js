import { Client } from "langsmith";
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config();

const client = new Client({ apiKey: process.env.LANGCHAIN_API_KEY });

async function main() {
    const targetPr = 84;
    const orgId = "c19cca98-e359-4ad2-b2ab-2cfc3a6bb863";
    const projectName = process.env.LANGCHAIN_PROJECT || "default";

    let finalOutput = `🕵️‍♂️ TRACE LIMPÍSSIMO DO PR #${targetPr} (KEYCLOAK)\n`;

    const rootRuns = [];
    for await (const run of client.listRuns({
        projectName,
        executionOrder: 1, limit: 100
    })) {
        if (run.extra?.metadata?.prNumber === targetPr || run.extra?.metadata?.pullRequestId === targetPr) {
            rootRuns.push(run);
        }
    }

    const agents = rootRuns.filter(r => r.name.includes("review-agent"));

    for (const run of agents) {
        finalOutput += `\n==================================================\n`;
        finalOutput += `🤖 AGENT: ${run.name.toUpperCase()}\n`;
        finalOutput += `==================================================\n`;

        const childRuns = [];
        for await (const child of client.listRuns({ traceId: run.trace_id })) {
            if (child.id !== run.id) childRuns.push(child);
        }
        childRuns.sort((a, b) => a.start_time - b.start_time);

        let turn = 1;
        for (const child of childRuns) {
            if (child.run_type === "llm") {
                const out = child.outputs;
                let text = '';
                
                if (out?.generations?.[0]?.[0]) {
                    text = out.generations[0][0].text || out.generations[0][0].message?.content || '';
                } else if (out?.output?.tool_calls) {
                     text = `[DECIDIU CHAMAR FERRAMENTAS: ${out.output.tool_calls.map(t => t.function?.name || t.name).join(', ')}]`;
                }

                if (text && text.trim() !== "{}") {
                    finalOutput += `\n🧠 [TURN ${turn} - THINKING]\n   ${text.replace(/\n/g, '\n   ').trim()}\n`;
                }
                turn++;
            } 
            else if (child.run_type === "tool") {
                let toolArgs = child.inputs.args || child.inputs.toolCall?.args || child.inputs;
                if (toolArgs.messages) { const clone = { ...toolArgs }; delete clone.messages; delete clone.system; toolArgs = clone; }
                
                finalOutput += `\n🛠️  [TURN ${turn} - ACTION] Tool: ${child.name}\n`;
                finalOutput += `   Input:  ${JSON.stringify(toolArgs)}\n`;
                
                let outStr = typeof child.outputs === 'string' ? child.outputs : JSON.stringify(child.outputs || {});
                try {
                     const parsedOut = JSON.parse(outStr);
                     if (parsedOut.output?.value) {
                         outStr = typeof parsedOut.output.value === 'string'
                             ? parsedOut.output.value
                             : JSON.stringify(parsedOut.output.value);
                     } else if (parsedOut.output) {
                         outStr = JSON.stringify(parsedOut.output);
                     }
                } catch(e) { }

                if (outStr.length > 800) {
                    outStr = outStr.substring(0, 800) + `\n      ... [TRUNCATED ${Math.round(outStr.length/1024)}KB of data]`;
                }

                finalOutput += `   Output:\n      ${outStr.replace(/\n/g, '\n      ')}\n`;
                turn++;
            }
        }
    }
    
    await fs.writeFile(`PR${targetPr}-TRACE.txt`, finalOutput);
}
main();
