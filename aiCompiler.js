const { GoogleGenAI } = require('@google/genai');

const geminiApiKeys = [
  ...(process.env.GEMINI_API_KEYS || '').split(','),
  process.env.GEMINI_API_KEY || ''
]
  .map(key => key.trim())
  .filter((key, index, keys) => key && keys.indexOf(key) === index);
const geminiClients = geminiApiKeys.map(apiKey => new GoogleGenAI({ apiKey }));

function getProviderError(err) {
  const message = String(err?.message || err);
  return redactProviderSecrets(message).replace(/\s+/g, ' ').slice(0, 400);
}

function shouldFailOverKey(status, message) {
  return (
    [400, 401, 403, 404, 429].includes(Number(status)) ||
    /NOT_FOUND|RESOURCE_EXHAUSTED|quota exceeded|no longer available|model .* not found/i.test(message)
  );
}

function redactProviderSecrets(message) {
  const keys = [
    ...geminiApiKeys,
    process.env.GROQ_API_KEY,
    process.env.MISTRAL_API_KEY,
    process.env.OPENROUTER_API_KEY
  ].filter(Boolean);
  return keys.reduce((safeMessage, key) => safeMessage.replaceAll(key, '[redacted]'), String(message));
}

function toOpenAIUserContent(contents) {
  return contents.map(content => {
    if (typeof content === 'string') return { type: 'text', text: content };
    if (content?.inlineData?.data) {
      const mimeType = content.inlineData.mimeType || 'image/png';
      return {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${content.inlineData.data}` }
      };
    }
    return { type: 'text', text: '[Unsupported attachment]' };
  });
}

async function callOpenAICompatibleProvider({
  name,
  url,
  apiKey,
  model,
  systemInstruction,
  contents,
  jsonMode,
  headers = {}
}) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: toOpenAIUserContent(contents) }
    ],
    temperature: 0.3
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`${name} returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const detail = redactProviderSecrets(data.error?.message || response.statusText || 'request failed');
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  const completion = data.choices?.[0]?.message?.content;
  const text = Array.isArray(completion)
    ? completion.map(part => part.text || '').join('')
    : completion;
  if (!text) throw new Error(`${name} response did not contain a completion.`);
  return text;
}

// ===================================================================
// 1. SOPHISTICATED MULTI-SYSTEM ARCHITECT PROMPT (Requirement #3 & #4)
// ===================================================================
const SOPHISTICATED_ARCHITECT_PROMPT = `
You are the Apex Discord.js v14 Autonomous System Architect, State-Machine Compiler, and Full-Stack Bot Engineer.
Nothing in this bot is hardcoded or template-bound. You design and synthesize 100% real, production-grade, crash-proof discord.js v14 JavaScript code capable of "Systems-within-Systems" (nested sub-menus, multi-modal intake chains, persistent database ledgers, role/channel provisioning, live pagination, admin control decks, and custom guild slash commands).

YOU MUST OUTPUT STRICT RAW JSON (NO MARKDOWN FENCES, NO EXTRA COMMENTARY) MATCHING THIS EXACT SCHEMA:
{
  "action": "ASK_QUESTIONS" | "COMPILE_SYSTEM",
  "replyToUser": "Clear, structured Discord Markdown message explaining your architecture, features, or clarifying questions.",
  "systemName": "Clean name of the system",
  "category": "Economy" | "Shop" | "Tickets" | "RPG" | "Security" | "Utility" | "Multi-System",
  "setupCode": "// Optional async JS code to provision roles/categories/channels on deploy, or empty string",
  "panelCode": "// Async JS code that builds and returns { content, embeds, components } for the main interactive hub",
  "handlerCode": "// Async JS code that handles ALL buttons, select menus, and modals across the main hub and all sub-systems",
  "commandConfig": {
    "name": "lowercase_alphanumeric_slash_name",
    "description": "Clean command description under 90 chars",
    "options": [
      {
        "name": "action",
        "description": "What action to run",
        "type": "STRING" | "INTEGER" | "BOOLEAN" | "USER" | "CHANNEL",
        "required": false
      }
    ]
  },
  "commandCode": "// Async JS code executed when a user runs the custom guild /command (REQUIRED if WANTS_SLASH_COMMAND is true)"
}

===================================================================
SOPHISTICATED "SYSTEMS-WITHIN-SYSTEMS" ARCHITECTURE RULES:
===================================================================
1. NESTED SUB-SYSTEM DESIGN:
   - Never build shallow, 1-button toy panels unless the user explicitly asks for something tiny.
   - Engineer complete ecosystems inside \`panelCode\`, \`handlerCode\`, and \`commandCode\`:
     * Layer 1 (Main Hub Panel): Rich status embed + primary navigation buttons or StringSelectMenu.
     * Layer 2 (User Sub-Systems): Multi-field Modal forms, dynamic profiles, inventories, queues, or private channel/thread provisioning.
     * Layer 3 (Admin / Staff Control Sub-System): Include a dedicated "⚙️ Admin / Manage" button on the panel (or sub-action in the slash command) guarded by:
       \`if (!interaction.member.permissions.has(Discord.PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: '❌ Staff only.', flags: Discord.MessageFlags.Ephemeral });\`
       Allow admins to add/remove items, configure settings, view logs, or reset queues via modals and update the main panel dynamically!
     * Layer 4 (Persistent State Ledger): Store all user balances, stock items, active tickets, cooldowns, and settings inside \`db\` so data survives restarts.

2. CUSTOM SERVER SLASH COMMAND SYNTHESIS (\`WANTS_SLASH_COMMAND\`):
   - When \`WANTS_SLASH_COMMAND\` is \`true\`:
     * You MUST populate \`commandConfig\` with a valid lowercase \`name\` (\`^[a-z0-9_-]{1,28}$\`), a clear \`description\`, and 1 to 5 useful \`options\`.
     * You MUST write complete, self-contained \`commandCode\` that handles \`ChatInputCommandInteraction\`.
     * The command must always acknowledge the interaction: call \`reply()\`/ \`deferReply()\` and then \`editReply()\`, or return a non-empty message payload. Never finish without a response.
     * Inside \`commandCode\`, read options using:
       - \`interaction.options.getString('name')\`
       - \`interaction.options.getInteger('name')\`
       - \`interaction.options.getBoolean('name')\`
       - \`interaction.options.getUser('name')\`
       - \`interaction.options.getChannel('name')\`
     * \`commandCode\` shares the exact same \`db\` store as \`panelCode\` and \`handlerCode\`! Any buttons, select menus, or modals sent inside \`commandCode\` will automatically route to \`handlerCode\` when clicked.

3. STRICT DISCORD.JS v14 RUNTIME RULES (ZERO-CRASH GUARANTEE):
   - NEVER use \`require()\` or \`import\`.
   - Available injected variables in ALL code blocks:
     * \`Discord\`: Full discord.js v14 namespace (\`EmbedBuilder\`, \`ActionRowBuilder\`, \`ButtonBuilder\`, \`ButtonStyle\`, \`StringSelectMenuBuilder\`, \`StringSelectMenuOptionBuilder\`, \`ModalBuilder\`, \`TextInputBuilder\`, \`TextInputStyle\`, \`ChannelType\`, \`PermissionFlagsBits\`, \`AttachmentBuilder\`, \`MessageFlags\`).
     * \`client\`, \`guild\`, \`channel\`: Live Discord instances.
     * \`interaction\`: Live interaction object inside \`handlerCode\` and \`commandCode\`. In \`panelCode\`, this is a read-only render context for the system creator (user/member/guild/channel/client), not a live Discord interaction.
     * \`db\`: Persistent MongoDB key-value store:
       - \`await db.get(key, defaultValue)\`
       - \`await db.set(key, value)\`
       - \`await db.push(key, item)\`
       - \`await db.inc(key, delta)\`
       - \`await db.delete(key)\`
       - \`await db.all()\`
     * \`askAI(prompt)\`: Async helper to query Gemini AI dynamically inside your generated system!
     * \`registerCreatedChannel(channelId)\` & \`registerCreatedRole(roleId)\`: Call whenever your code creates a channel or role.
   - CRITICAL INTERACTION TIMING RULES:
     * \`panelCode\` runs while rendering a preview/deployment, not in response to a click. It may read \`interaction.user\` or \`interaction.member\`, but MUST NOT call \`reply()\`, \`deferReply()\`, \`deferUpdate()\`, \`update()\`, \`followUp()\`, or \`showModal()\`. Put all interaction responses and modal handling in \`handlerCode\`.
     * \`interaction.customId\` is automatically stripped of internal session prefixes. If you set \`.setCustomId('buy_item')\`, check \`if (interaction.customId === 'buy_item')\`.
     * If you open a Modal (\`await interaction.showModal(modal)\`), it MUST be the FIRST response—NEVER call \`deferReply\` or \`deferUpdate\` before \`showModal\`!
     * Before any slow async operation (creating channels, multiple DB writes, calling \`askAI\`), ALWAYS call \`await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral })\` (and then use \`interaction.editReply(...)\`).
   - STRICT DISCORD API LIMITS:
     * Button \`.setLabel()\` max 80 chars.
     * Modal \`.setTitle()\` max 45 chars.
     * TextInput \`.setLabel()\` max 45 chars. Max 5 ActionRows per Modal, 1 TextInput per ActionRow.
     * Embed \`.setTitle()\` max 256 chars, \`.setDescription()\` max 4000 chars, field \`name\` max 256 chars, field \`value\` max 1024 chars (never empty string \`""\`—use \`"None"\` or \`"N/A"\`!).
`;

// ===================================================================
// 2. FORENSIC DEEP BUG-FIX PROMPT (Requirement #5)
// ===================================================================
const DEDICATED_BUG_FIX_PROMPT = `
You are the Apex Discord.js v14 Forensic Debugger, Static Analyzer, and Self-Healing Compiler.
Your job is to inspect the broken or buggy system (\`setupCode\`, \`panelCode\`, \`handlerCode\`, \`commandConfig\`, \`commandCode\`), the runtime stack trace, static linter warnings, and the user's \`!bug\` report, and repair 100% of the issues.

YOU MUST OUTPUT STRICT RAW JSON (NO MARKDOWN FENCES) MATCHING THIS EXACT SCHEMA:
{
  "fixed": true | false,
  "diagnosisSummary": "Detailed bulleted explanation of every bug found and how you repaired it.",
  "unfixableReason": "Only if fixed is false (e.g. the Discord bot lacks Administrator/ManageRoles permission in the server or role hierarchy is blocked), explain what the server owner must fix.",
  "setupCode": "// Complete repaired setupCode",
  "panelCode": "// Complete repaired panelCode",
  "handlerCode": "// Complete repaired handlerCode",
  "commandConfig": {
    "name": "lowercase_cmd_name",
    "description": "Repaired description",
    "options": []
  },
  "commandCode": "// Complete repaired commandCode"
}

FORENSIC DEBUGGING RULES:
1. Inspect ALL 4 code blocks (\`setupCode\`, \`panelCode\`, \`handlerCode\`, AND \`commandCode\`) plus \`commandConfig\`.
2. Fix any Discord API validation errors:
   - Empty embed field values (\`value: ""\` -> \`value: "None"\`).
   - Modal field labels > 45 characters or Button labels > 80 characters.
   - Invalid hex colors (always use 6-digit hex like \`#5865F2\` or integer colors).
   - Missing \`return { embeds: [...], components: [...] };\` at the end of \`panelCode\`.
3. Fix any Interaction lifecycle bugs:
   - Calling \`showModal()\` after \`deferReply()\` or \`deferUpdate()\`.
   - Calling \`reply()\` twice on an already-replied or deferred interaction (use \`editReply\` or \`followUp\`).
   - Unhandled \`customId\` branches where clicking a button or submitting a modal does nothing!
4. NEVER return truncated code or comments like \`// ... existing code ...\`. Always return the 100% complete, runnable JavaScript for every block.
`;

const JSON_REPAIR_PROMPT = `
You repair malformed JSON returned by another AI model.
Return only one valid JSON object. Preserve every key, value, and intended code string exactly.
Only correct JSON formatting and escaping errors. Do not add Markdown fences or explanations.
`;

function repairInvalidJsonEscapes(text) {
  let repaired = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!inString && char === '"') {
      inString = true;
      repaired += char;
      continue;
    }
    if (inString && char === '"') {
      inString = false;
      repaired += char;
      continue;
    }
    if (!inString) {
      repaired += char;
      continue;
    }

    if (char === '\\') {
      const next = text[i + 1];
      if ('"\\/bfnrt'.includes(next)) {
        repaired += char + next;
        i++;
      } else if (
        next === 'u' &&
        /^[\da-fA-F]{4}$/.test(text.slice(i + 2, i + 6))
      ) {
        repaired += text.slice(i, i + 6);
        i += 5;
      } else {
        repaired += '\\\\';
      }
      continue;
    }

    if (char === '\n') repaired += '\\n';
    else if (char === '\r') repaired += '\\r';
    else if (char === '\t') repaired += '\\t';
    else if (char.charCodeAt(0) < 0x20) repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else repaired += char;
  }

  return repaired;
}

// ===================================================================
// 3. STATIC CODE LINTER, v13->v14 AUTO-PATCHER & AST DRY-RUN VALIDATOR
// ===================================================================
function autoPatchDiscordJsCode(code = '') {
  if (!code || typeof code !== 'string') return '';
  let patched = code.trim();

  // Strip accidental markdown code fences if the LLM included them inside a string
  patched = patched.replace(/^```(?:javascript|js)?\n?/i, '').replace(/\n?```$/i, '');

  // Strip illegal require() statements that would crash the sandbox
  patched = patched.replace(/(?:const|let|var)\s+[^=]+=\s*require\([^)]+\);?/g, '// [Auto-Linter: stripped require]');

  // Auto-patch common Discord.js v13 string styles to v14 enums
  patched = patched
    .replace(/\.setStyle\(\s*['"]PRIMARY['"]\s*\)/g, '.setStyle(Discord.ButtonStyle.Primary)')
    .replace(/\.setStyle\(\s*['"]SECONDARY['"]\s*\)/g, '.setStyle(Discord.ButtonStyle.Secondary)')
    .replace(/\.setStyle\(\s*['"]SUCCESS['"]\s*\)/g, '.setStyle(Discord.ButtonStyle.Success)')
    .replace(/\.setStyle\(\s*['"]DANGER['"]\s*\)/g, '.setStyle(Discord.ButtonStyle.Danger)')
    .replace(/\.setStyle\(\s*['"]SHORT['"]\s*\)/g, '.setStyle(Discord.TextInputStyle.Short)')
    .replace(/\.setStyle\(\s*['"]PARAGRAPH['"]\s*\)/g, '.setStyle(Discord.TextInputStyle.Paragraph)')
    .replace(/Discord\.MessageEmbed/g, 'Discord.EmbedBuilder')
    .replace(/Discord\.MessageActionRow/g, 'Discord.ActionRowBuilder')
    .replace(/Discord\.MessageButton/g, 'Discord.ButtonBuilder')
    .replace(/Discord\.MessageSelectMenu/g, 'Discord.StringSelectMenuBuilder')
    .replace(/\.addComponent\(/g, '.addComponents(');

  return patched;
}

function validateAndLintSystemObject(rawObj, wantsSlashCommand, fallbackSystemName) {
  const warnings = [];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const setupCode = autoPatchDiscordJsCode(rawObj.setupCode || '');
  const panelCode = autoPatchDiscordJsCode(rawObj.panelCode || '');
  const handlerCode = autoPatchDiscordJsCode(rawObj.handlerCode || '');
  const commandCode = autoPatchDiscordJsCode(rawObj.commandCode || '');

  // Check syntax of each block using V8's parser via AsyncFunction constructor
  const blocksToCheck = [
    { name: 'setupCode', code: setupCode },
    { name: 'panelCode', code: panelCode },
    { name: 'handlerCode', code: handlerCode },
    { name: 'commandCode', code: commandCode }
  ];

  const syntaxErrors = [];
  for (const blk of blocksToCheck) {
    if (!blk.code) continue;
    try {
      new AsyncFunction(
        'Discord',
        'client',
        'guild',
        'channel',
        'interaction',
        'db',
        'askAI',
        'registerCreatedChannel',
        'registerCreatedRole',
        blk.code
      );
    } catch (syntaxErr) {
      syntaxErrors.push(`${blk.name} SyntaxError:${syntaxErr.message}`);
    }
  }

  if (panelCode && !panelCode.includes('return')) {
    warnings.push('panelCode was missing a return statement.');
  }

  // Sanitize commandConfig
  const defaultSlug = String(rawObj.systemName || fallbackSystemName || 'custom_cmd')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 28) || 'custom_cmd';

  const rawCfg = rawObj.commandConfig || {};
  const cleanCmdName = String(rawCfg.name || defaultSlug)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 28) || defaultSlug;

  const validTypes = ['STRING', 'INTEGER', 'BOOLEAN', 'USER', 'CHANNEL'];
  const cleanOptions = Array.isArray(rawCfg.options)
    ? rawCfg.options.slice(0, 5).map((opt, idx) => ({
        name:
          String(opt.name || `option_${idx + 1}`)
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '')
            .slice(0, 28) || `opt_${idx + 1}`,
        description: String(opt.description || 'Command parameter').slice(0, 90),
        type: validTypes.includes(String(opt.type).toUpperCase()) ? String(opt.type).toUpperCase() : 'STRING',
        required: Boolean(opt.required)
      }))
    : [];

  return {
    sanitized: {
      action: rawObj.action === 'ASK_QUESTIONS' ? 'ASK_QUESTIONS' : 'COMPILE_SYSTEM',
      replyToUser: String(rawObj.replyToUser || 'System compiled and ready.'),
      systemName: String(rawObj.systemName || fallbackSystemName || 'Custom AI System').slice(0, 50),
      category: ['Economy', 'Shop', 'Tickets', 'RPG', 'Security', 'Utility', 'Multi-System'].includes(rawObj.category)
        ? rawObj.category
        : 'Multi-System',
      setupCode,
      panelCode,
      handlerCode,
      commandConfig: {
        name: cleanCmdName,
        description: String(rawCfg.description || `Execute ${fallbackSystemName || 'system'}`).slice(0, 90),
        options: cleanOptions
      },
      commandCode:
        commandCode ||
        (wantsSlashCommand
          ? `await interaction.reply({ content: '⚡ **${fallbackSystemName}** command executed!', flags: Discord.MessageFlags.Ephemeral });`
          : ''),
      lintWarnings: warnings
    },
    syntaxErrors
  };
}

// ===================================================================
// 4. IMAGE INGESTION & MULTI-PROVIDER AI CASCADE
// ===================================================================
async function fetchImagePart(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image attachment: ${res.statusText}`);
  const contentType = res.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    inlineData: {
      data: buf.toString('base64'),
      mimeType: contentType
    }
  };
}

async function callAIWithCascade(systemInstruction, contents, onStepCallback = null, retries = 3, jsonMode = true) {
  const geminiModels = ['gemini-3.8-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
  const providerErrors = [];

  if (geminiClients.length === 0) {
    providerErrors.push('Gemini: GEMINI_API_KEYS or GEMINI_API_KEY is not configured.');
  }

  for (const modelName of geminiModels) {
    for (let keyIndex = 0; keyIndex < geminiClients.length; keyIndex++) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          if (onStepCallback) {
            await onStepCallback(
              `Querying ${modelName} with Gemini key ${keyIndex + 1}/${geminiClients.length} (Attempt ${attempt}/${retries})...`
            );
          }
          const config = { temperature: 0.35 };
          if (jsonMode) config.responseMimeType = 'application/json';
          const response = await geminiClients[keyIndex].models.generateContent({
            model: modelName,
            contents: [systemInstruction, ...contents],
            config
          });
          if (response && response.text) {
            return { text: response.text, provider: `${modelName} (key ${keyIndex + 1})` };
          }
          providerErrors.push(`${modelName} (key ${keyIndex + 1}): returned an empty response`);
          break;
        } catch (err) {
          const errorMessage = getProviderError(err);
          const status = err?.status || err?.code;
          console.warn(
            `[AI Cascade] ${modelName}, Gemini key ${keyIndex + 1}, attempt ${attempt} failed: ${errorMessage}`
          );
          providerErrors.push(
            `${modelName} (key ${keyIndex + 1})${status ? ` (HTTP ${status})` : ''}: ${errorMessage}`
          );
          if (shouldFailOverKey(status, errorMessage)) break;
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, attempt * 1400));
          }
        }
      }
    }
  }

  // Try every configured backup provider, moving on as soon as one fails.
  if (process.env.GROQ_API_KEY) {
    try {
      const configuredGroqModel = process.env.GROQ_MODEL;
      const groqModel =
        !configuredGroqModel || configuredGroqModel === 'llama-3.3-70b-versatile'
          ? 'openai/gpt-oss-120b'
          : configuredGroqModel;
      if (onStepCallback) await onStepCallback(`Trying Groq (${groqModel})...`);
      const textPrompt = contents.map(c => (typeof c === 'string' ? c : '[Image Attachment]')).join('\n\n');
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: textPrompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3
        })
      });
      const responseText = await groqRes.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(`Groq returned invalid JSON (HTTP ${groqRes.status}).`);
      }
      if (!groqRes.ok) {
        throw new Error(
          `HTTP ${groqRes.status}: ${data.error?.message || groqRes.statusText || 'request failed'}`
        );
      }
      if (data.choices?.[0]?.message?.content) {
        return { text: data.choices[0].message.content, provider: `Groq (${groqModel})` };
      }
      throw new Error('Groq response did not contain a completion.');
    } catch (groqErr) {
      const errorMessage = redactProviderSecrets(groqErr?.message || groqErr);
      console.warn('[AI Cascade] Groq fallback failed:', errorMessage);
      providerErrors.push(`Groq: ${errorMessage.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  } else {
    providerErrors.push('Groq: GROQ_API_KEY is not configured.');
  }

  const backupProviders = [
    process.env.MISTRAL_API_KEY && {
      name: 'Mistral',
      url: 'https://api.mistral.ai/v1/chat/completions',
      apiKey: process.env.MISTRAL_API_KEY,
      model: process.env.MISTRAL_MODEL || 'mistral-small-latest'
    },
    process.env.OPENROUTER_API_KEY && {
      name: 'OpenRouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'openrouter/free',
      headers: {
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://github.com/jhonlong872-afk/ultimate',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Ultimate Discord Architect'
      }
    }
  ].filter(Boolean);

  for (const provider of backupProviders) {
    try {
      if (onStepCallback) await onStepCallback(`Failing over to ${provider.name} (${provider.model})...`);
      const text = await callOpenAICompatibleProvider({
        ...provider,
        systemInstruction,
        contents,
        jsonMode
      });
      return { text, provider: `${provider.name} (${provider.model})` };
    } catch (providerErr) {
      const errorMessage = redactProviderSecrets(providerErr?.message || providerErr)
        .replace(/\s+/g, ' ')
        .slice(0, 400);
      console.warn(`[AI Cascade] ${provider.name} fallback failed: ${errorMessage}`);
      providerErrors.push(`${provider.name}: ${errorMessage}`);
    }
  }

  if (!process.env.MISTRAL_API_KEY) providerErrors.push('Mistral: MISTRAL_API_KEY is not configured.');
  if (!process.env.OPENROUTER_API_KEY) providerErrors.push('OpenRouter: OPENROUTER_API_KEY is not configured.');

  const details = providerErrors.join(' | ');
  const quotaExhausted = providerErrors.some(error => /HTTP 429|RESOURCE_EXHAUSTED|quota exceeded/i.test(error));
  throw new Error(
    `${quotaExhausted ? 'An AI provider quota is exhausted or rate-limited. Add billing/increase its quota or wait for it to reset.' : 'All configured AI providers failed.'} ${details}`
  );
}

async function parseAIJson(rawText, context, onStepCallback = null) {
  try {
    return JSON.parse(rawText);
  } catch (parseError) {
    try {
      return JSON.parse(repairInvalidJsonEscapes(rawText));
    } catch {
      // A backup model may still recover structural JSON errors that cannot be fixed locally.
    }

    if (onStepCallback) {
      await onStepCallback('AI response was invalid JSON; requesting a backup model to repair its formatting...');
    }

    let malformedText = rawText;
    let lastRepairError = parseError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const repair = await callAIWithCascade(
        JSON_REPAIR_PROMPT,
        [
          `Expected response context: ${context}`,
          `Repair attempt: ${attempt}`,
          `JSON parse error: ${lastRepairError.message}`,
          'Malformed response:',
          malformedText
        ],
        onStepCallback,
        1
      );

      try {
        return JSON.parse(repair.text);
      } catch (repairError) {
        malformedText = repair.text;
        lastRepairError = repairError;
      }
    }
    throw new Error(
      `AI returned invalid JSON and the backup repair failed after 2 attempts: ${lastRepairError.message}`,
      { cause: parseError }
    );
  }
}

// ===================================================================
// 5. CONVERSATION TURN COMPILER WITH PRE-FLIGHT AUTO-HEALING
// ===================================================================
async function runConversationTurn(session, forceCompile = false, onStepCallback = null) {
  const cleanDefaultCmdName = (session.systemName || 'system')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 26) || 'custom_cmd';

  let modeSpecificDirective = '';
  if (session.mode === 'autopilot') {
    modeSpecificDirective = `
      ACTIVE MODE: 🚀 AUTO-PILOT (10X EXPANSION).
      Immediately set "action": "COMPILE_SYSTEM". Expand the user's request into a deep, multi-layered system with user workflows, modals, persistent database tracking via \`db\`, and an admin management sub-panel!
    `;
  } else if (session.mode === 'help' && !forceCompile && session.compiledSystem?.version === 0) {
    modeSpecificDirective = `
      ACTIVE MODE: 💬 HELP / INTERACTIVE CONSULTANT.
      If the user has not answered your design questions yet, set "action": "ASK_QUESTIONS" and ask 3-4 sharp architectural questions to customize their system. If they already answered or asked you to build now, set "action": "COMPILE_SYSTEM".
    `;
  } else {
    modeSpecificDirective = `
      ACTIVE MODE: ⚡ NORMAL / ITERATIVE BUILDER.
      Set "action": "COMPILE_SYSTEM" and synthesize or update the full system code accurately based on the user's latest instructions.
    `;
  }

  const contextBlock = `
SYSTEM NAME: "${session.systemName}"
${modeSpecificDirective}
WANTS_SLASH_COMMAND: ${
    session.wantsSlashCommand
      ? `TRUE — You MUST generate "commandConfig" (default name: "${cleanDefaultCmdName}") AND full "commandCode" so this system has a working guild slash command!`
      : 'FALSE'
  }
${forceCompile ? 'FORCE COMPILE OVERRIDE: You MUST set "action": "COMPILE_SYSTEM" and output complete working code now!' : ''}

EXISTING COMPILED CODE (v${session.compiledSystem?.version || 0}):
${
  session.compiledSystem?.panelCode
    ? JSON.stringify(
        {
          setupCode: session.compiledSystem.setupCode,
          panelCode: session.compiledSystem.panelCode,
          handlerCode: session.compiledSystem.handlerCode,
          commandConfig: session.compiledSystem.commandConfig,
          commandCode: session.compiledSystem.commandCode
        },
        null,
        2
      )
    : 'None yet (Fresh synthesis)'
}
`;

  const historyText = session.conversation
    .slice(-14)
    .map((m, idx) => `[Turn ${idx + 1} - ${m.role.toUpperCase()}]:${m.content}`)
    .join('\n\n');

  const recentImages = [];
  for (const msg of session.conversation.slice(-2)) {
    if (Array.isArray(msg.imageUrls)) recentImages.push(...msg.imageUrls);
  }

  const contents = [`${contextBlock}\n\nCONVERSATION LOG:\n${historyText}`];
  for (const url of recentImages.slice(0, 2)) {
    try {
      contents.push(await fetchImagePart(url));
    } catch (_) {}
  }

  const { text: rawJsonText, provider } = await callAIWithCascade(
    SOPHISTICATED_ARCHITECT_PROMPT,
    contents,
    onStepCallback
  );

  let parsed = await parseAIJson(rawJsonText, 'architect system response', onStepCallback);
  let { sanitized, syntaxErrors } = validateAndLintSystemObject(
    parsed,
    session.wantsSlashCommand,
    session.systemName
  );

  // Pre-Flight Auto-Heal: If the AI wrote a JavaScript SyntaxError, automatically repair it before returning!
  if (syntaxErrors.length > 0 && sanitized.action === 'COMPILE_SYSTEM') {
    if (onStepCallback) {
      await onStepCallback(`Pre-flight AST caught ${syntaxErrors.length} syntax error(s). Auto-healing...`);
    }
    const healResult = await callAIWithCascade(
      DEDICATED_BUG_FIX_PROMPT,
      [
        `PRE-FLIGHT SYNTAX ERRORS DETECTED:\n${syntaxErrors.join('\n')}\n\nBROKEN CODE OBJECT:\n${JSON.stringify(sanitized, null, 2)}`
      ],
      onStepCallback
    );
    const healedParsed = await parseAIJson(healResult.text, 'repaired architect system response', onStepCallback);
    const revalidated = validateAndLintSystemObject(
      { ...sanitized, ...healedParsed, action: 'COMPILE_SYSTEM' },
      session.wantsSlashCommand,
      session.systemName
    );
    sanitized = revalidated.sanitized;
  }

  return { ...sanitized, provider };
}

// ===================================================================
// 6. FORENSIC BUG-FIX RUNNER (Requirement #5: !bug & Fix Bugs Button)
// ===================================================================
async function runBugFixDiagnostic(session, userBugReport = '', onStepCallback = null) {
  if (onStepCallback) {
    await onStepCallback('Running static AST analysis & inspecting stack traces...');
  }

  const currentCheck = validateAndLintSystemObject(
    {
      systemName: session.systemName,
      setupCode: session.compiledSystem?.setupCode,
      panelCode: session.compiledSystem?.panelCode,
      handlerCode: session.compiledSystem?.handlerCode,
      commandConfig: session.compiledSystem?.commandConfig,
      commandCode: session.compiledSystem?.commandCode
    },
    session.wantsSlashCommand,
    session.systemName
  );

  const diagnosticPayload = `
SYSTEM NAME: "${session.systemName}"
WANTS SLASH COMMAND: ${session.wantsSlashCommand}
STATIC LINTER / SYNTAX CHECK WARNINGS:
${currentCheck.syntaxErrors.length > 0 ? currentCheck.syntaxErrors.join('\n') : 'No syntax errors.'}

LAST CAPTURED RUNTIME ERROR STACK:
${session.compiledSystem?.lastError || 'No automatic runtime stack trace captured.'}

USER BUG REPORT / SYMPTOMS:
${userBugReport || 'Inspect and repair all broken buttons, select menus, modals, database calls, and the guild slash command.'}

CURRENT SYSTEM CODE TO DEBUG & REPAIR:
${JSON.stringify(
  {
    setupCode: session.compiledSystem?.setupCode || '',
    panelCode: session.compiledSystem?.panelCode || '',
    handlerCode: session.compiledSystem?.handlerCode || '',
    commandConfig: session.compiledSystem?.commandConfig || {},
    commandCode: session.compiledSystem?.commandCode || ''
  },
  null,
  2
)}
`;

  const { text: rawJsonText, provider } = await callAIWithCascade(
    DEDICATED_BUG_FIX_PROMPT,
    [diagnosticPayload],
    onStepCallback
  );

  const parsed = await parseAIJson(rawJsonText, 'forensic bug-fix diagnosis', onStepCallback);
  const { sanitized, syntaxErrors } = validateAndLintSystemObject(
    {
      ...parsed,
      systemName: session.systemName,
      action: 'COMPILE_SYSTEM'
    },
    session.wantsSlashCommand,
    session.systemName
  );

  return {
    fixed: Boolean(parsed.fixed) && syntaxErrors.length === 0,
    diagnosisSummary: String(parsed.diagnosisSummary || 'Repaired code logic and interaction handlers.'),
    unfixableReason:
      syntaxErrors.length > 0
        ? `Syntax validation failed after repair: ${syntaxErrors.join(', ')}`
        : parsed.unfixableReason || null,
    setupCode: sanitized.setupCode,
    panelCode: sanitized.panelCode,
    handlerCode: sanitized.handlerCode,
    commandConfig: sanitized.commandConfig,
    commandCode: sanitized.commandCode,
    provider
  };
}

// ===================================================================
// 7. RUNTIME AI HELPER (Available inside generated code as askAI())
// ===================================================================
async function askRuntimeAI(promptText) {
  try {
    const result = await callAIWithCascade(
      'Answer the user clearly and concisely. Return plain text, not JSON.',
      [String(promptText)],
      null,
      1,
      false
    );
    return result.text;
  } catch (err) {
    return `AI Runtime Error: ${redactProviderSecrets(err.message)}`;
  }
}

module.exports = {
  runConversationTurn,
  runBugFixDiagnostic,
  validateAndLintSystemObject,
  askRuntimeAI,
  repairInvalidJsonEscapes
};