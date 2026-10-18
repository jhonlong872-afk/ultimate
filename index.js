require('dotenv').config();
const Discord = require('discord.js');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags
} = Discord;
const mongoose = require('mongoose');
const {
  TIER_LIMITS,
  UserProfile,
  ArchitectSession,
  PublicModel,
  BugLog
} = require('./models');
const {
  runConversationTurn,
  runBugFixDiagnostic,
  askRuntimeAI
} = require('./aiCompiler');

const OWNER_USER_ID = '1159932392908279849';
const isOwner = userId => userId === OWNER_USER_ID;
const limitDiscordContent = (content, limit = 1900) => {
  const text = String(content || '');
  return text.length > limit ? `${text.slice(0, limit - 24)}\n… (truncated)` : text;
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Stores pre-thread parameters when the mandatory Naming Modal pops up
const pendingArchitectSetups = new Map();

// Per-message edit throttle map to prevent Discord rate limits (Requirement #6)
const editThrottleMap = new Map();

// ===================================================================
// 1. RATE-LIMIT-SAFE IN-PLACE MESSAGE EDITOR (Requirement #6)
// ===================================================================
async function safeEditMessage(message, payload, forceImmediate = false) {
  if (!message) return null;
  const now = Date.now();
  const lastEdit = editThrottleMap.get(message.id) || 0;

  // Skip intermediate progress edits if edited < 1.8s ago to avoid rate limits
  if (!forceImmediate && now - lastEdit < 1800) {
    return message;
  }

  editThrottleMap.set(message.id, now);
  return message.edit(payload).catch(() => null);
}

// ===================================================================
// 2. CORE SLASH COMMAND DEFINITIONS (/architect, /models, /public)
// ===================================================================
const coreCommands = [
  new SlashCommandBuilder()
    .setName('architect')
    .setDescription('Build any custom Discord system with AI (Requires naming your item)')
    .addStringOption(opt =>
      opt
        .setName('mode')
        .setDescription('Choose how the AI should collaborate with you')
        .setRequired(true)
        .addChoices(
          { name: '🚀 Auto-Pilot (AI expands simple idea 10x into nested systems)', value: 'autopilot' },
          { name: '💬 Help / Interview (AI asks questions before compiling)', value: 'help' },
          { name: '⚡ Normal (Direct conversational builder)', value: 'normal' }
        )
    )
    .addBooleanOption(opt =>
      opt
        .setName('slash_command')
        .setDescription('True = Also generate & register a custom /command for this system in this server!')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt
        .setName('name')
        .setDescription('Name of the item/system you are making (Leave blank to open Naming Popup)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt
        .setName('prompt')
        .setDescription('Describe what you want the AI to build')
        .setRequired(false)
    )
    .addAttachmentOption(opt =>
      opt.setName('image_1').setDescription('Optional reference screenshot 1').setRequired(false)
    )
    .addAttachmentOption(opt =>
      opt.setName('image_2').setDescription('Optional reference screenshot 2').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('models')
    .setDescription('View & manage all AI models in this server, linked threads, /commands & Live Process Monitor'),

  new SlashCommandBuilder()
    .setName('public')
    .setDescription('Open the Public Model Marketplace, Ratings, Promotions, Credits & Tiers Hub')
];

// ===================================================================
// 3. USER PROFILE, TIERS, CREDITS & SILVER SERVER-JOIN VERIFIER
// ===================================================================
async function getOrCreateProfile(userId) {
  const today = new Date().toISOString().slice(0, 10);
  let profile = await UserProfile.findOne({ userId });
  if (!profile) {
    profile = await UserProfile.create({
      userId,
      creditLedger: [{ amount: 125, reason: 'Welcome Starter Bonus' }]
    });
  }
  if (profile.dailyStats?.dateKey !== today) {
    profile.dailyStats = { dateKey: today, modelsCreated: 0, publicModelsUsed: 0, bugsFixed: 0 };
    await profile.save();
  }

  // Automatically grant Silver Tier if the user is in SUPPORT_SERVER_ID
  if (process.env.SUPPORT_SERVER_ID && profile.tier === 'FREE') {
    const supportGuild = client.guilds.cache.get(process.env.SUPPORT_SERVER_ID);
    if (supportGuild) {
      const member = await supportGuild.members.fetch(userId).catch(() => null);
      if (member) {
        profile.tier = 'SILVER';
        profile.claimedServerSilver = true;
        profile.creditLedger.push({ amount: 0, reason: 'Unlocked Silver Tier (Joined Support Server)' });
        await profile.save();
      }
    }
  }
  return profile;
}

async function adjustUserCredits(userId, delta, reason) {
  const profile = await getOrCreateProfile(userId);
  profile.credits = Math.max(0, (profile.credits || 0) + delta);
  if (delta > 0) profile.totalCreditsEarned = (profile.totalCreditsEarned || 0) + delta;
  if (delta < 0) profile.totalCreditsSpent = (profile.totalCreditsSpent || 0) + Math.abs(delta);

  profile.creditLedger.unshift({ amount: delta, reason, timestamp: new Date() });
  if (profile.creditLedger.length > 25) profile.creditLedger = profile.creditLedger.slice(0, 25);

  await profile.save();
  return profile;
}

// ===================================================================
// 4. IN-DISCORD LIVE PROCESS & DATABASE TELEMETRY MONITOR
// ===================================================================
async function buildInDiscordProcessMonitor(session) {
  const unresolvedBugs = await BugLog.countDocuments({ sessionId: session.sessionId, resolved: false });
  const dbKeys = Object.keys(session.runtimeStore || {});
  const jsonPreview = JSON.stringify(session.runtimeStore || {}, null, 2);
  const recentSteps = (session.telemetry?.processLogs || [])
    .slice(-5)
    .map(l => `• \`${new Date(l.timestamp).toLocaleTimeString()}\` — ${l.step}`)
    .join('\n') || '• Waiting for next compilation...';

  const monitorEmbed = new EmbedBuilder()
    .setAuthor({ name: `📡 In-Discord Live Process & Database Telemetry Monitor` })
    .setTitle(`⚙️ System Telemetry: ${session.systemName} (\`#${session.sessionId}\`)`)
    .setDescription(
      `Live compiler pipeline status, interaction metrics, and real-time MongoDB state memory for **${session.systemName}**.`
    )
    .addFields(
      { name: '🔄 Current Pipeline State', value: `\`${session.telemetry?.currentStep || 'Idle / Ready'}\``, inline: true },
      { name: '📦 Active Version', value: `\`v${session.compiledSystem?.version || 0}\` (\`${session.status}\`)`, inline: true },
      { name: '⚡ AI Provider & Speed', value: `\`${session.telemetry?.lastProviderUsed || 'gemini-3.8-flash'}\` (\`${session.telemetry?.lastCompileDurationMs || 0}ms\`)`, inline: true },
      { name: '🖱️ Component Runs', value: `\`${session.telemetry?.totalInteractionsHandled || 0}\` clicks/modals`, inline: true },
      { name: '⌨️ Guild /Command Runs', value: `\`${session.telemetry?.totalSlashRuns || 0}\` executions`, inline: true },
      { name: '🩹 Bug Fixes / Open Bugs', value: `\`${session.telemetry?.bugFixesRun || 0}\` fixed / \`${unresolvedBugs}\` open`, inline: true },
      { name: '📋 Recent Pipeline Process Trace', value: recentSteps, inline: false },
      {
        name: `🗄️ Live Runtime Database Store (${dbKeys.length} Keys)`,
        value: `\`\`\`json\n${jsonPreview.slice(0, 900)}\n\`\`\``,
        inline: false
      }
    )
    .setColor('#3498db')
    .setTimestamp(session.telemetry?.lastActiveAt || new Date());

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`procmon_refresh_${session.sessionId}`)
      .setLabel('🔄 Refresh Telemetry')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`procmon_editdb_${session.sessionId}`)
      .setLabel('✏️ Set / Edit DB Key')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`procmon_delkey_${session.sessionId}`)
      .setLabel('➖ Delete DB Key')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`procmon_exportdb_${session.sessionId}`)
      .setLabel('📥 Export DB JSON')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`procmon_wipedb_${session.sessionId}`)
      .setLabel('🧹 Wipe DB')
      .setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`procmon_bugs_${session.sessionId}`)
      .setLabel(`🐞 Inspect Bug Logs (${unresolvedBugs})`)
      .setStyle(unresolvedBugs > 0 ? ButtonStyle.Danger : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`procmon_versions_${session.sessionId}`)
      .setLabel(`⏪ Version History (${session.versionHistory?.length || 0})`)
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [monitorEmbed], components: [row1, row2] };
}

// ===================================================================
// 5. GUILD SLASH COMMAND SYNC ENGINE (Requirement #4 & #7)
// ===================================================================
async function syncGuildSlashCommand(guild, session, enable = true) {
  if (!guild) throw new Error('Cannot register the generated slash command because its server was not found.');

  if (!enable || !session.wantsSlashCommand || !session.compiledSystem?.commandCode) {
    if (session.registeredCommandId) {
      await guild.commands.delete(session.registeredCommandId).catch(() => {});
      session.registeredCommandId = null;
    }
    session.slashCommandEnabled = false;
    await session.save();
    return null;
  }

  const rawCfg = session.compiledSystem.commandConfig || {};
  let cmdName = (rawCfg.name || session.systemName || `cmd_${session.sessionId}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 28);

  if (!cmdName || ['architect', 'models', 'public'].includes(cmdName)) {
    cmdName = `sys_${cmdName || session.sessionId}`.slice(0, 28);
  }

  const guildCommands = await guild.commands.fetch();
  const existingCommand = session.registeredCommandId
    ? guildCommands.get(session.registeredCommandId)
    : null;
  if (guildCommands.some(command => command.name === cmdName && command.id !== existingCommand?.id)) {
    cmdName = `${cmdName.slice(0, 21)}_${session.sessionId}`.slice(0, 28);
  }

  const builder = new SlashCommandBuilder()
    .setName(cmdName)
    .setDescription((rawCfg.description || `Run ${session.systemName}`).slice(0, 95));

  const seenOpts = new Set();
  const options = (rawCfg.options || [])
    .slice(0, 5)
    .sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
  for (const opt of options) {
    const optName = String(opt.name || 'input')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 28);
    if (!optName || seenOpts.has(optName)) continue;
    seenOpts.add(optName);

    const optDesc = String(opt.description || 'Parameter').slice(0, 95);
    const req = Boolean(opt.required);

    if (opt.type === 'INTEGER') {
      builder.addIntegerOption(o => o.setName(optName).setDescription(optDesc).setRequired(req));
    } else if (opt.type === 'BOOLEAN') {
      builder.addBooleanOption(o => o.setName(optName).setDescription(optDesc).setRequired(req));
    } else if (opt.type === 'USER') {
      builder.addUserOption(o => o.setName(optName).setDescription(optDesc).setRequired(req));
    } else if (opt.type === 'CHANNEL') {
      builder.addChannelOption(o => o.setName(optName).setDescription(optDesc).setRequired(req));
    } else {
      builder.addStringOption(o => o.setName(optName).setDescription(optDesc).setRequired(req));
    }
  }

  try {
    const registered = existingCommand
      ? await guild.commands.edit(existingCommand.id, builder.toJSON())
      : await guild.commands.create(builder.toJSON());

    session.compiledSystem.commandConfig.name = cmdName;
    session.registeredCommandId = registered.id;
    session.slashCommandEnabled = true;
    await session.save();
    return registered;
  } catch (err) {
    session.slashCommandEnabled = false;
    await session.save();
    throw new Error(`Failed to register /${cmdName}: ${err.message}`, { cause: err });
  }
}

// ===================================================================
// 6. DYNAMIC EXECUTION SANDBOX & AUTO-PREFIX PROXY
// ===================================================================
function prefixPayloadCustomIds(payload, sessionId) {
  if (!payload || typeof payload !== 'object') return payload;
  const prefix = `dyn_${sessionId}_`;

  if (payload instanceof Discord.ModalBuilder || payload.data?.custom_id || payload.customId) {
    const modalJson = typeof payload.toJSON === 'function' ? payload.toJSON() : { ...payload };
    if (modalJson.custom_id && !modalJson.custom_id.startsWith(prefix)) {
      modalJson.custom_id = `${prefix}${modalJson.custom_id}`;
    }
    return modalJson;
  }

  const cloned = { ...payload };
  if (Array.isArray(cloned.components)) {
    cloned.components = cloned.components.map(row => {
      const rowJson = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
      if (Array.isArray(rowJson.components)) {
        rowJson.components = rowJson.components.map(comp => {
          const compJson = typeof comp.toJSON === 'function' ? comp.toJSON() : { ...comp };
          if (
            compJson.custom_id &&
            !compJson.custom_id.startsWith(prefix) &&
            !compJson.custom_id.startsWith('archctl_')
          ) {
            compJson.custom_id = `${prefix}${compJson.custom_id}`;
          }
          return compJson;
        });
      }
      return rowJson;
    });
  }
  return cloned;
}

function normalizeGeneratedMessagePayload(payload, allowEmptyComponents = false) {
  const normalized = typeof payload === 'string' ? { content: payload } : payload;
  const hasPayload =
    normalized &&
    typeof normalized === 'object' &&
    (String(normalized.content || '').trim() ||
      normalized.embeds?.length ||
      normalized.components?.length ||
      normalized.files?.length ||
      normalized.attachments?.length ||
      normalized.poll ||
      (allowEmptyComponents && Array.isArray(normalized.components)));
  if (!hasPayload) {
    throw new Error('Generated code tried to send an empty Discord message.');
  }
  return normalized;
}

function wrapChannelForRouting(channel, sessionId) {
  if (!channel) return channel;
  return new Proxy(channel, {
    get(target, prop) {
      if (prop === 'send') {
        return async payload => {
          const formatted = prefixPayloadCustomIds(normalizeGeneratedMessagePayload(payload), sessionId);
          return target.send(formatted);
        };
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}

function wrapInteractionForRouting(interaction, sessionId, cleanCustomId) {
  return new Proxy(interaction, {
    get(target, prop) {
      if (prop === 'customId') return cleanCustomId;
      if (prop === 'channel') return wrapChannelForRouting(target.channel, sessionId);
      if (['reply', 'editReply', 'followUp', 'update'].includes(prop)) {
        return async payload => {
          const formatted = prefixPayloadCustomIds(
            normalizeGeneratedMessagePayload(payload, ['editReply', 'update'].includes(prop)),
            sessionId
          );
          return target[prop](formatted);
        };
      }
      if (prop === 'showModal') {
        return async modal => target.showModal(prefixPayloadCustomIds(modal, sessionId));
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}

async function createPanelRenderContext(session, guild, channel) {
  const user = client.users.cache.get(session.creatorId) || (await client.users.fetch(session.creatorId));
  const member =
    guild.members.cache.get(session.creatorId) || (await guild.members.fetch(session.creatorId));
  const unsupportedResponse = () => {
    throw new Error('Panel rendering has no live Discord interaction; put reply, modal, and defer logic in handlerCode.');
  };

  return {
    isRenderContext: true,
    user,
    member,
    guild,
    channel,
    client,
    reply: unsupportedResponse,
    deferReply: unsupportedResponse,
    deferUpdate: unsupportedResponse,
    editReply: unsupportedResponse,
    followUp: unsupportedResponse,
    update: unsupportedResponse,
    showModal: unsupportedResponse
  };
}

function createScopedDbHelper(session) {
  if (!session.runtimeStore || typeof session.runtimeStore !== 'object') {
    session.runtimeStore = {};
  }
  return {
    get: async (key, def = null) => (session.runtimeStore[key] !== undefined ? session.runtimeStore[key] : def),
    set: async (key, val) => {
      session.runtimeStore[key] = val;
      session.markModified('runtimeStore');
      await session.save();
      return val;
    },
    push: async (key, item) => {
      if (!Array.isArray(session.runtimeStore[key])) session.runtimeStore[key] = [];
      session.runtimeStore[key].push(item);
      session.markModified('runtimeStore');
      await session.save();
      return session.runtimeStore[key];
    },
    inc: async (key, delta = 1) => {
      session.runtimeStore[key] = (Number(session.runtimeStore[key]) || 0) + delta;
      session.markModified('runtimeStore');
      await session.save();
      return session.runtimeStore[key];
    },
    delete: async key => {
      delete session.runtimeStore[key];
      session.markModified('runtimeStore');
      await session.save();
    },
    all: async () => session.runtimeStore
  };
}

async function executeAiCodeBlock({
  session,
  code,
  guild,
  channel,
  interaction = null,
  interactionContext = null,
  cleanCustomId = null
}) {
  if (!code || !code.trim()) return null;
  const db = createScopedDbHelper(session);
  const wrappedChannel = wrapChannelForRouting(channel, session.sessionId);
  const resolvedInteractionContext =
    interactionContext ||
    (!interaction && code === session.compiledSystem?.panelCode
      ? await createPanelRenderContext(session, guild, channel)
      : null);
  const wrappedInteraction = interaction
    ? wrapInteractionForRouting(interaction, session.sessionId, cleanCustomId)
    : resolvedInteractionContext;

  const registerCreatedChannel = async chId => {
    if (!session.deployedResources.createdChannelIds.includes(chId)) {
      session.deployedResources.createdChannelIds.push(chId);
      await session.save();
    }
  };
  const registerCreatedRole = async roleId => {
    if (!session.deployedResources.createdRoleIds.includes(roleId)) {
      session.deployedResources.createdRoleIds.push(roleId);
      await session.save();
    }
  };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    'Discord',
    'client',
    'guild',
    'channel',
    'interaction',
    'db',
    'askAI',
    'registerCreatedChannel',
    'registerCreatedRole',
    code
  );

  const result = await fn(
    Discord,
    client,
    guild,
    wrappedChannel,
    wrappedInteraction,
    db,
    askRuntimeAI,
    registerCreatedChannel,
    registerCreatedRole
  );
  return prefixPayloadCustomIds(result, session.sessionId);
}

// ===================================================================
// 7. ANTI-CLUTTER IN-PLACE WORKSPACE & PREVIEW UPDATER (Requirement #6)
// ===================================================================
function buildWorkspaceControlRows(session) {
  const hasCompiled = Boolean(session.compiledSystem?.panelCode);
  const row1 = new ActionRowBuilder();

  if (!hasCompiled) {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`archctl_forcecompile_${session.sessionId}`)
        .setLabel('⚡ Compile & Build System Now')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`archctl_monitor_${session.sessionId}`)
        .setLabel('📡 Process & DB Monitor')
        .setStyle(ButtonStyle.Secondary)
    );
    return [row1];
  }

  row1.addComponents(
    new ButtonBuilder()
      .setCustomId(`archctl_deploy_${session.sessionId}`)
      .setLabel(session.status === 'DEPLOYED' ? '🔄 Update Live Panel' : '🚀 Deploy to Server')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`archctl_bugfix_${session.sessionId}`)
      .setLabel('🩹 Fix Bugs')
      .setStyle(session.compiledSystem?.lastError ? ButtonStyle.Danger : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`archctl_monitor_${session.sessionId}`)
      .setLabel('📡 Process & DB')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`archctl_publish_${session.sessionId}`)
      .setLabel('🌐 Post to /public')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`archctl_code_${session.sessionId}`)
      .setLabel('💻 Code')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder();
  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(`archctl_testpanel_${session.sessionId}`)
      .setLabel('🧪 Deploy Test Panel')
      .setStyle(ButtonStyle.Primary)
  );

  if (session.wantsSlashCommand) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`archctl_togglecmd_${session.sessionId}`)
        .setLabel(
          session.slashCommandEnabled
            ? `🔌 Disable /${session.compiledSystem?.commandConfig?.name || 'cmd'}`
            : `🔌 Enable /${session.compiledSystem?.commandConfig?.name || 'cmd'}`
        )
        .setStyle(session.slashCommandEnabled ? ButtonStyle.Secondary : ButtonStyle.Success)
    );
  }

  if ((session.versionHistory?.length || 0) > 1) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`archctl_versions_${session.sessionId}`)
        .setLabel(`⏪ Versions (${session.versionHistory.length})`)
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (session.status === 'DEPLOYED') {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`archctl_rollback_${session.sessionId}`)
        .setLabel('🗑️ Undeploy Panel')
        .setStyle(ButtonStyle.Danger)
    );
  }

  const rows = [row1];
  if (row2.components.length > 0) rows.push(row2);
  return rows;
}

async function updateTestPanelPreview(session, thread) {
  const renderedPreview = await executeAiCodeBlock({
    session,
    code: session.compiledSystem?.panelCode,
    guild: thread.guild,
    channel: thread
  });
  const payload = normalizeGeneratedMessagePayload(renderedPreview);
  const previewPayload = {
    ...payload,
    content:
      String(payload.content || '').trim() ||
      `🧪 **Test Panel (v${session.compiledSystem.version})** — Interactions are routed to this generated system.`
  };

  let previewMessage = null;
  if (session.previewMessageId) {
    const oldPreview = await thread.messages.fetch(session.previewMessageId).catch(() => null);
    if (oldPreview) previewMessage = await safeEditMessage(oldPreview, previewPayload, true);
  }
  if (!previewMessage) {
    previewMessage = await thread.send(previewPayload);
    session.previewMessageId = previewMessage.id;
    await session.save();
  }
  return previewMessage;
}

function buildDeployChannelPrompt(session) {
  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`archctl_deploychannel_${session.sessionId}`)
    .setPlaceholder('Choose where to deploy the panel')
    .setChannelTypes(Discord.ChannelType.GuildText, Discord.ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);
  return {
    content: `Choose a text channel for **${session.systemName}**. The current panel will only be replaced after the new panel is sent successfully.`,
    components: [new ActionRowBuilder().addComponents(channelSelect)],
    flags: MessageFlags.Ephemeral
  };
}

async function deployPanelToChannel(session, guild, targetChannel) {
  if (
    !targetChannel ||
    targetChannel.guildId !== guild.id ||
    ![Discord.ChannelType.GuildText, Discord.ChannelType.GuildAnnouncement].includes(targetChannel.type)
  ) {
    throw new Error('Choose a text or announcement channel in this server.');
  }

  if (session.compiledSystem.setupCode?.trim()) {
    await executeAiCodeBlock({
      session,
      code: session.compiledSystem.setupCode,
      guild,
      channel: targetChannel
    });
  }

  const panelPayload = await executeAiCodeBlock({
    session,
    code: session.compiledSystem.panelCode,
    guild,
    channel: targetChannel
  });
  const sent = await targetChannel.send(normalizeGeneratedMessagePayload(panelPayload));
  const oldChannelId = session.deployedResources?.panelChannelId;
  const oldMessageId = session.deployedResources?.panelMessageId;

  session.status = 'DEPLOYED';
  session.deployedResources.panelChannelId = targetChannel.id;
  session.deployedResources.panelMessageId = sent.id;
  await session.save();

  if (oldChannelId && oldMessageId) {
    const oldChannel =
      guild.channels.cache.get(oldChannelId) || (await guild.channels.fetch(oldChannelId).catch(() => null));
    if (oldChannel) {
      const oldMessage = await oldChannel.messages.fetch(oldMessageId).catch(() => null);
      if (oldMessage) await oldMessage.delete().catch(() => {});
    }
  }
  return sent;
}

async function recordProcessStep(session, thread, stepLabel, forceImmediate = false) {
  if (!session.telemetry) session.telemetry = {};
  session.telemetry.currentStep = stepLabel;
  session.telemetry.lastActiveAt = new Date();
  if (!Array.isArray(session.telemetry.processLogs)) session.telemetry.processLogs = [];
  session.telemetry.processLogs.push({ step: stepLabel, timestamp: new Date() });
  if (session.telemetry.processLogs.length > 15) {
    session.telemetry.processLogs = session.telemetry.processLogs.slice(-15);
  }
  await session.save();

  if (session.workspaceMessageId && thread) {
    const msg = await thread.messages.fetch(session.workspaceMessageId).catch(() => null);
    if (msg && msg.embeds[0]) {
      const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
        .setAuthor({ name: `⏳ [LIVE PROCESS]: ${stepLabel}` })
        .setColor('#f1c40f');
      await safeEditMessage(msg, { embeds: [updatedEmbed] }, forceImmediate);
    }
  }
}

async function upsertWorkspaceAndPreview(session, thread, aiReplyText) {
  const cmdBadge = session.wantsSlashCommand
    ? session.slashCommandEnabled
      ? `✅ \`/${session.compiledSystem?.commandConfig?.name}\``
      : `⏸️ Disabled (\`/${session.compiledSystem?.commandConfig?.name || 'pending'}\`)`
    : '❌ Off';

  const masterEmbed = new EmbedBuilder()
    .setAuthor({
      name: `Architect Workspace • ${session.systemName} (#${session.sessionId})`
    })
    .setTitle(
      session.status === 'CONVERSING'
        ? `💬 Designing: ${session.systemName}`
        : `✨ ${session.systemName} — v${session.compiledSystem?.version || 1} (${session.category || 'Multi-System'})`
    )
    .setDescription(
      (aiReplyText || session.compiledSystem?.summary || 'Ready for instructions.').slice(0, 3800)
    )
    .addFields(
      { name: '🛠️ Mode', value: `\`${session.mode.toUpperCase()}\``, inline: true },
      { name: '⚡ Guild /Command', value: cmdBadge, inline: true },
      {
        name: '📡 Process & Speed',
        value: `\`${session.telemetry?.currentStep || 'Ready'}\` (\`${session.telemetry?.lastCompileDurationMs || 0}ms\`)`,
        inline: true
      }
    )
    .setColor(
      session.compiledSystem?.lastError
        ? '#e74c3c'
        : session.status === 'COMPILED' || session.status === 'DEPLOYED'
        ? '#2ecc71'
        : '#5865F2'
    )
    .setFooter({
      text: `Edits: ${session.editsUsed} • Versions Saved: ${session.versionHistory?.length || 0} • Type normally to update in-place or !bug to fix bugs.`
    });

  if (session.compiledSystem?.lastError) {
    masterEmbed.addFields({
      name: '⚠️ Detected Runtime Bug (Click "🩹 Fix Bugs" or type `!bug`)',
      value: `\`\`\`js\n${String(session.compiledSystem.lastError).slice(0, 450)}\n\`\`\``
    });
  }

  const workspacePayload = {
    embeds: [masterEmbed],
    components: buildWorkspaceControlRows(session)
  };

  let updatedWorkspaceMsg = null;
  if (session.workspaceMessageId) {
    const existingMsg = await thread.messages.fetch(session.workspaceMessageId).catch(() => null);
    if (existingMsg) {
      updatedWorkspaceMsg = await safeEditMessage(existingMsg, workspacePayload, true);
    }
  }
  if (!updatedWorkspaceMsg) {
    updatedWorkspaceMsg = await thread.send(workspacePayload);
    session.workspaceMessageId = updatedWorkspaceMsg.id;
    await session.save();
  }

  // Edit Single Live Preview Message in-place (Zero duplicate panel clutter!)
  if (session.compiledSystem?.panelCode) {
    try {
      await updateTestPanelPreview(session, thread);
    } catch (renderErr) {
      session.compiledSystem.lastError = `panelCode Render Error: ${renderErr.stack || renderErr.message}`;
      await session.save();
      await safeEditMessage(
        updatedWorkspaceMsg,
        {
          embeds: [
            EmbedBuilder.from(masterEmbed)
              .setColor('#e74c3c')
              .addFields({
                name: '⚠️ Panel Render Bug Detected',
                value: `\`\`\`js\n${renderErr.message.slice(0, 400)}\n\`\`\`\nClick **🩹 Fix Bugs** or type \`!bug\` to auto-repair!`
              })
          ],
          components: buildWorkspaceControlRows(session)
        },
        true
      );
    }
  }
}

// ===================================================================
// 8. CONVERSATION TURN, VERSION SNAPSHOTS & DEEP BUG-FIX RUNNERS
// ===================================================================
async function saveVersionSnapshot(session, maxHistory = 10) {
  if (!session.compiledSystem?.panelCode) return;
  if (!Array.isArray(session.versionHistory)) session.versionHistory = [];

  session.versionHistory.push({
    version: session.compiledSystem.version,
    summary: (session.compiledSystem.summary || 'Compiled version').slice(0, 200),
    setupCode: session.compiledSystem.setupCode,
    panelCode: session.compiledSystem.panelCode,
    handlerCode: session.compiledSystem.handlerCode,
    commandConfig: session.compiledSystem.commandConfig,
    commandCode: session.compiledSystem.commandCode,
    savedAt: new Date()
  });

  if (session.versionHistory.length > maxHistory) {
    session.versionHistory = session.versionHistory.slice(-maxHistory);
  }
}

async function processTurnInPlace(session, thread, forceCompile = false) {
  try {
    return await processTurnInPlaceUnsafe(session, thread, forceCompile);
  } catch (err) {
    console.error('[System Build Error]:', err);
    const failureMessage = `System build failed: ${err.message}`.slice(0, 900);

    await thread.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ System Build Could Not Complete')
          .setDescription(
            'Your request remains saved in this system thread. If the AI returned malformed JSON, a backup repair prompt was attempted. Send another instruction to retry.'
          )
          .addFields({ name: 'Error details', value: `\`\`\`\n${failureMessage}\n\`\`\`` })
          .setColor('#e74c3c')
          .setTimestamp()
      ]
    });

    session.compiledSystem.lastError = failureMessage;
    session.telemetry = {
      ...(session.telemetry || {}),
      currentStep: 'System build failed',
      lastActiveAt: new Date()
    };
    await session.save();
    await upsertWorkspaceAndPreview(
      session,
      thread,
      `⚠️ **Build failed.** Your request remains saved in this thread. Send another instruction to retry.\n${failureMessage}`
    );
  }
}

async function processTurnInPlaceUnsafe(session, thread, forceCompile = false) {
  const startTime = Date.now();
  const profile = await getOrCreateProfile(session.creatorId);
  const maxHistory = isOwner(session.creatorId)
    ? Infinity
    : TIER_LIMITS[profile.tier]?.maxVersionHistory || 5;

  await recordProcessStep(session, thread, '1/3 Synthesizing Multi-System Architecture...', true);

  const aiRes = await runConversationTurn(session, forceCompile, async stepText => {
    await recordProcessStep(session, thread, stepText, false);
  });

  const compileMs = Date.now() - startTime;

  session.conversation.push({
    role: 'assistant',
    content: aiRes.replyToUser || 'Updated system.'
  });

  if (aiRes.action === 'COMPILE_SYSTEM' && aiRes.panelCode) {
    await recordProcessStep(session, thread, '2/3 Validating AST & Syncing Guild Commands...', false);
    session.status = session.status === 'DEPLOYED' ? 'DEPLOYED' : 'COMPILED';
    session.category = aiRes.category || session.category || 'Multi-System';

    const nextVersion = (session.compiledSystem?.version || 0) + 1;
    session.compiledSystem = {
      systemName: session.systemName,
      summary: aiRes.replyToUser || '',
      setupCode: aiRes.setupCode || '',
      panelCode: aiRes.panelCode || '',
      handlerCode: aiRes.handlerCode || '',
      commandConfig: aiRes.commandConfig || session.compiledSystem?.commandConfig || { name: '', description: '', options: [] },
      commandCode: aiRes.commandCode || session.compiledSystem?.commandCode || '',
      version: nextVersion,
      lastError: null,
      lintWarnings: aiRes.lintWarnings || []
    };

    await saveVersionSnapshot(session, maxHistory);

    if (session.wantsSlashCommand && session.compiledSystem.commandCode) {
      await syncGuildSlashCommand(thread.guild, session, true);
    }

    // Update live deployed panel in-place if already deployed!
    if (session.status === 'DEPLOYED' && session.deployedResources?.panelChannelId && session.deployedResources?.panelMessageId) {
      const liveCh = thread.guild.channels.cache.get(session.deployedResources.panelChannelId);
      if (liveCh) {
        const liveMsg = await liveCh.messages.fetch(session.deployedResources.panelMessageId).catch(() => null);
        if (liveMsg) {
          const freshLivePayload = await executeAiCodeBlock({
            session,
            code: session.compiledSystem.panelCode,
            guild: thread.guild,
            channel: liveCh
          }).catch(() => null);
          if (freshLivePayload) await safeEditMessage(liveMsg, freshLivePayload, true);
        }
      }
    }
  }

  session.telemetry = {
    ...(session.telemetry || {}),
    currentStep: 'Idle / Ready',
    lastProviderUsed: aiRes.provider || 'gemini-3.8-flash',
    lastCompileDurationMs: compileMs,
    lastActiveAt: new Date()
  };
  await session.save();
  await upsertWorkspaceAndPreview(session, thread, aiRes.replyToUser);
}

/**
 * Requirement #5: Forensic Bug Fix Runner (Button or !bug) + Unfixable Bug Logger
 */
async function triggerDeepBugFix(session, userId, bugContext = '') {
  const thread = await client.channels.fetch(session.threadId);
  if (!thread?.isThread()) {
    throw new Error(`System thread ${session.threadId} for session ${session.sessionId} was not found.`);
  }

  const startTime = Date.now();
  await recordProcessStep(session, thread, 'Running Forensic Bug Diagnosis...', true);

  const diagnosis = await runBugFixDiagnostic(session, bugContext, async stepText => {
    await recordProcessStep(session, thread, stepText, false);
  });

  const compileMs = Date.now() - startTime;
  session.telemetry = {
    ...(session.telemetry || {}),
    currentStep: 'Idle / Ready',
    lastProviderUsed: diagnosis.provider || 'gemini-3.8-flash',
    lastCompileDurationMs: compileMs,
    bugFixesRun: (session.telemetry?.bugFixesRun || 0) + 1,
    lastActiveAt: new Date()
  };

  if (diagnosis.fixed && diagnosis.panelCode) {
    session.compiledSystem.setupCode = diagnosis.setupCode ?? session.compiledSystem.setupCode;
    session.compiledSystem.panelCode = diagnosis.panelCode;
    session.compiledSystem.handlerCode = diagnosis.handlerCode ?? session.compiledSystem.handlerCode;
    if (diagnosis.commandConfig?.name) session.compiledSystem.commandConfig = diagnosis.commandConfig;
    if (diagnosis.commandCode) session.compiledSystem.commandCode = diagnosis.commandCode;
    session.compiledSystem.version = (session.compiledSystem.version || 0) + 1;
    session.compiledSystem.lastError = null;

    await saveVersionSnapshot(session, isOwner(session.creatorId) ? Infinity : 10);
    await session.save();

    await BugLog.updateMany({ sessionId: session.sessionId, resolved: false }, { resolved: true });

    if (session.wantsSlashCommand && session.slashCommandEnabled) {
      await syncGuildSlashCommand(thread.guild, session, true);
    }

    // Also update deployed live message if deployed
    if (session.status === 'DEPLOYED' && session.deployedResources?.panelChannelId && session.deployedResources?.panelMessageId) {
      const liveCh = thread.guild.channels.cache.get(session.deployedResources.panelChannelId);
      if (liveCh) {
        const liveMsg = await liveCh.messages.fetch(session.deployedResources.panelMessageId).catch(() => null);
        if (liveMsg) {
          const freshLivePayload = await executeAiCodeBlock({
            session,
            code: session.compiledSystem.panelCode,
            guild: thread.guild,
            channel: liveCh
          }).catch(() => null);
          if (freshLivePayload) await safeEditMessage(liveMsg, freshLivePayload, true);
        }
      }
    }

    await upsertWorkspaceAndPreview(
      session,
      thread,
      `🩹 **Forensic Bug Repair Complete (v${session.compiledSystem.version}):**\n${diagnosis.diagnosisSummary}`
    );
    return { fixed: true, summary: diagnosis.diagnosisSummary };
  }

  // Log unfixable bug and dispatch report
  const bugId = Math.random().toString(36).substring(2, 8);
  const unfixedLog = await BugLog.create({
    bugId,
    sessionId: session.sessionId,
    guildId: thread.guild.id,
    userId,
    systemName: session.systemName,
    stage: 'Forensic Bug Fixer',
    rawError: session.compiledSystem?.lastError || bugContext || 'Unresolved logic/permission error',
    codeSnippet: (session.compiledSystem?.handlerCode || '').slice(0, 600),
    aiDiagnosis: diagnosis.diagnosisSummary || 'Could not automatically patch.',
    resolved: false,
    unfixableReason: diagnosis.unfixableReason || 'Requires manual admin permission or role hierarchy adjustment.'
  });

  const bugReportEmbed = new EmbedBuilder()
    .setTitle(`🚨 Unresolved Bug Log (#${bugId}) —${session.systemName}`)
    .setDescription(
      String(diagnosis.diagnosisSummary || 'The automated bug fixer encountered an unfixable issue.').slice(0, 4000)
    )
    .addFields(
      { name: '📌 Session / Thread', value: `\`#${session.sessionId}\` (<#${thread.id}>)`, inline: true },
      { name: '👤 Triggered By', value: `<@${userId}>`, inline: true },
      { name: '⚠️ Why It Could Not Be Auto-Fixed', value: `\`\`\`\n${unfixedLog.unfixableReason.slice(0, 500)}\n\`\`\`` },
      { name: '🧾 Raw Error / Stack Trace', value: `\`\`\`js\n${String(unfixedLog.rawError).slice(0, 500)}\n\`\`\`` }
    )
    .setColor('#e74c3c')
    .setTimestamp();

  await thread.send({ embeds: [bugReportEmbed] });
  return { fixed: false, summary: unfixedLog.unfixableReason };
}

// ===================================================================
// 9. SPAWN ARCHITECT SESSION & NAMED THREAD (Requirement #7)
// ===================================================================
async function spawnNamedArchitectThread({
  interaction,
  systemName,
  mode,
  wantsSlashCommand,
  initialPrompt,
  imageUrls
}) {
  const profile = await getOrCreateProfile(interaction.user.id);
  const tierSpec = TIER_LIMITS[profile.tier];

  if (!isOwner(interaction.user.id) && profile.dailyStats.modelsCreated >= tierSpec.dailyModels) {
    return interaction.editReply({
      content: `⛔ **Daily Model Limit Reached!** Your **${tierSpec.emoji}${tierSpec.name} Tier** allows **${tierSpec.dailyModels}** new models per day.\n👉 Run \`/public\` and click **💎 Tiers & Upgrade Shop** to claim **Free Silver** (by joining our server) or upgrade to **Gold / Premium**!`
    });
  }

  profile.dailyStats.modelsCreated += 1;
  await profile.save();

  const sessionId = Math.random().toString(36).substring(2, 8);
  const cleanTitle = systemName.trim().slice(0, 45);

  const thread = await interaction.channel.threads.create({
    name: `🛠️-${cleanTitle}-${sessionId}`.slice(0, 95),
    autoArchiveDuration: 60,
    reason: `Architect System: ${cleanTitle}`
  });

  const session = await ArchitectSession.create({
    sessionId,
    guildId: interaction.guild.id,
    creatorId: interaction.user.id,
    threadId: thread.id,
    systemName: cleanTitle,
    mode,
    wantsSlashCommand,
    status: 'CONVERSING',
    conversation: [
      {
        role: 'user',
        content:
          initialPrompt ||
          `Build the "${cleanTitle}" system (${wantsSlashCommand ? 'including a custom server /command' : 'panel & interactive system'}).`,
        imageUrls
      }
    ],
    deployedResources: {
      panelChannelId: interaction.channel.id,
      createdChannelIds: [],
      createdRoleIds: []
    }
  });

  session.telemetry = {
    ...(session.telemetry || {}),
    currentStep: 'Starting AI provider cascade...',
    lastActiveAt: new Date()
  };
  await session.save();
  await upsertWorkspaceAndPreview(
    session,
    thread,
    '⏳ **System created.** Connecting to AI providers and preparing your first build...'
  );

  await interaction.editReply({
    content: `✅ **Created \`${cleanTitle}\`!** Jump into your workspace thread: <#${thread.id}>`
  });

  await processTurnInPlace(session, thread, mode === 'autopilot');
}

// ===================================================================
// 10. /PUBLIC MARKETPLACE, CATEGORIES, REVIEWS, TIPS & TIERS UI (Req #1 & #2)
// ===================================================================
async function buildPublicMarketplaceView(
  userId,
  sortBy = 'promoted',
  page = 0,
  searchQuery = '',
  categoryFilter = 'ALL'
) {
  const profile = await getOrCreateProfile(userId);
  const tierSpec = TIER_LIMITS[profile.tier];

  const filter = {};
  if (categoryFilter && categoryFilter !== 'ALL') {
    filter.category = categoryFilter;
  }
  if (searchQuery) {
    filter.$or = [
      { name: { $regex: searchQuery, $options: 'i' } },
      { description: { $regex: searchQuery, $options: 'i' } }
    ];
  }

  let sortQuery = { promotedCreditsSpent: -1, score: -1, createdAt: -1 };
  if (sortBy === 'top') sortQuery = { score: -1, installsCount: -1 };
  if (sortBy === 'clones') sortQuery = { installsCount: -1, score: -1 };
  if (sortBy === 'new') sortQuery = { createdAt: -1 };

  const totalModels = await PublicModel.countDocuments(filter);
  const models = await PublicModel.find(filter).sort(sortQuery).skip(page * 5).limit(5);

  const embed = new EmbedBuilder()
    .setTitle('🌐 Public AI Model Hub & Creator Marketplace')
    .setDescription(
      `Browse, rate 👍/👎, review, promote with Credits, and **1-Click Clone** community-engineered systems & slash commands!\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 **Your Tier:** ${isOwner(userId) ? '👑 Owner (Unlimited)' : `${tierSpec.emoji} **${tierSpec.name}**`}  |  🪙 **Balance:** \`${profile.credits} Cr\` (🔥 Streak: \`${profile.dailyStreak}d\`)\n` +
      `📊 **Today's Usage:** \`${profile.dailyStats.modelsCreated}/${isOwner(userId) ? '∞' : tierSpec.dailyModels}\` Builds • \`${profile.dailyStats.publicModelsUsed}/${isOwner(userId) ? '∞' : tierSpec.dailyPublicUses}\` Public Clones` +
      (categoryFilter !== 'ALL' ? `\n📂 **Category:** \`${categoryFilter}\`` : '') +
      (searchQuery ? `  |  🔎 **Search:** \`"${searchQuery}"\`` : '')
    )
    .setColor('#5865F2')
    .setFooter({
      text: `Page ${page + 1} of${Math.max(1, Math.ceil(totalModels / 5))} (${totalModels} Models) • Sort: ${sortBy.toUpperCase()}`
    });

  if (models.length === 0) {
    embed.addFields({
      name: '📭 No Matching Public Models Found',
      value: 'Try switching categories or publish your own creation from `/architect` using **🌐 Post to /public**!'
    });
  } else {
    models.forEach((m, idx) => {
      const isPromoted = m.promotedCreditsSpent > 0;
      const badge = isPromoted ? `🔥 **[PROMOTED • ${m.promotedCreditsSpent} Cr]** ` : `\`#${page * 5 + idx + 1}\` `;
      const cmdTag = m.hasSlashCommand ? `⚡ \`/${m.compiledSystem?.commandConfig?.name || 'cmd'}\`` : '🖼️ Panel';
      embed.addFields({
        name: `${badge}${m.name} [${m.category}] (\`ID: ${m.publicId}\`)`,
        value:
          `> ${m.description.slice(0, 140)}\n` +
          `👍 **${m.upvoterIds.length}**  👎 **${m.downvoterIds.length}** (Score: \`${m.score}\`) • 💬 **${m.reviews?.length || 0}** • 📥 **${m.installsCount}** Clones • ${cmdTag} • By **${m.authorTag}**`
      });
    });
  }

  const components = [];

  // Row 1: Select Model to Inspect / Clone / Rate / Promote
  if (models.length > 0) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('pub_select_model')
          .setPlaceholder('🔍 Select a Model to Clone, Rate 👍/👎, Review, Inspect Code, or Promote...')
          .addOptions(
            models.map(m => ({
              label: `${m.promotedCreditsSpent > 0 ? '🔥 ' : ''}${m.name} (${m.category})`.slice(0, 95),
              description: `👍 ${m.upvoterIds.length} 👎 ${m.downvoterIds.length} | 📥 ${m.installsCount} Clones | ${m.hasSlashCommand ? 'Includes /cmd' : 'Panel'} | By ${m.authorTag}`.slice(0, 95),
              value: m.publicId,
              emoji: m.promotedCreditsSpent > 0 ? '🔥' : '📦'
            }))
          )
      )
    );
  }

  // Row 2: Category Filter Dropdown
  const categories = ['ALL', 'Economy', 'Shop', 'Tickets', 'RPG', 'Security', 'Utility', 'Multi-System'];
  components.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`pub_cat_${sortBy}`)
        .setPlaceholder(`📂 Filter by Category (Current: ${categoryFilter})`)
        .addOptions(
          categories.map(cat => ({
            label: cat === 'ALL' ? '🌐 All Categories' : `📂 ${cat} Systems`,
            value: cat,
            default: cat === categoryFilter
          }))
        )
    )
  );

  // Row 3: Sorting & Pagination Buttons
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pub_sort_promoted_${page}_${categoryFilter}`)
        .setLabel('🔥 Promoted')
        .setStyle(sortBy === 'promoted' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pub_sort_top_${page}_${categoryFilter}`)
        .setLabel('⭐ Top Rated')
        .setStyle(sortBy === 'top' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pub_sort_clones_${page}_${categoryFilter}`)
        .setLabel('📥 Most Cloned')
        .setStyle(sortBy === 'clones' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`pub_page_${sortBy}_${Math.max(0, page - 1)}_${categoryFilter}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`pub_page_${sortBy}_${page + 1}_${categoryFilter}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled((page + 1) * 5 >= totalModels)
    )
  );

  // Row 4: Tiers Shop, Daily Credits, Search, Leaderboard, Publish
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('pub_open_tiers')
        .setLabel('💎 Tiers & Credits Shop')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('pub_claim_daily')
        .setLabel('🪙 Daily Credits')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('pub_search_modal')
        .setLabel('🔎 Search')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('pub_leaderboard')
        .setLabel('🏆 Leaderboard')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('pub_publish_picker')
        .setLabel('📤 Publish Mine')
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return { embeds: [embed], components };
}

function buildPublicModelDetailCard(pubModel) {
  const recentReviews = (pubModel.reviews || [])
    .slice(-3)
    .map(r => `${r.rating === 'GOOD' ? '👍' : '👎'} **${r.userTag}:** "${r.comment}"`)
    .join('\n') || '*No written reviews yet. Click **💬 Review** to leave one!*';

  const detailEmbed = new EmbedBuilder()
    .setTitle(`${pubModel.promotedCreditsSpent > 0 ? '🔥 ' : '📦 '}${pubModel.name} (\`#${pubModel.publicId}\`)`)
    .setDescription(pubModel.description || 'AI-Engineered Discord System')
    .addFields(
      { name: '👤 Creator', value: `${pubModel.authorTag}`, inline: true },
      { name: '📂 Category', value: `\`${pubModel.category || 'Multi-System'}\``, inline: true },
      { name: '⭐ Score', value: `👍 **${pubModel.upvoterIds.length}** | 👎 **${pubModel.downvoterIds.length}** (\`${pubModel.score}\`)`, inline: true },
      { name: '📥 Total Clones', value: `\`${pubModel.installsCount}\` servers`, inline: true },
      { name: '🔥 Promotion Boost', value: `\`${pubModel.promotedCreditsSpent} Cr\``, inline: true },
      { name: '🎁 Tips Earned', value: `\`${pubModel.tipsReceived || 0} Cr\``, inline: true },
      {
        name: '⚡ Custom Guild /Command Included',
        value: pubModel.hasSlashCommand
          ? `✅ Includes \`/${pubModel.compiledSystem?.commandConfig?.name || 'cmd'}\` — Automatically registered in your server when you Clone!`
          : '➖ Interactive Panel & Backend Handlers Only',
        inline: false
      },
      { name: '💬 Recent Community Reviews', value: recentReviews, inline: false }
    )
    .setColor(pubModel.promotedCreditsSpent > 0 ? '#f1c40f' : '#5865F2');

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pubact_clone_${pubModel.publicId}`)
      .setLabel('📥 1-Click Clone to Server')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`pubact_good_${pubModel.publicId}`)
      .setLabel(`👍 Good (${pubModel.upvoterIds.length})`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`pubact_bad_${pubModel.publicId}`)
      .setLabel(`👎 Bad (${pubModel.downvoterIds.length})`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`pubact_review_${pubModel.publicId}`)
      .setLabel('💬 Write Review')
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pubact_promote_${pubModel.publicId}`)
      .setLabel('🔥 Boost Promotion (100 Cr)')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`pubact_tip_${pubModel.publicId}`)
      .setLabel('🎁 Tip Creator (+50 Cr)')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`pubact_inspect_${pubModel.publicId}`)
      .setLabel('💻 Inspect Code')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [detailEmbed], components: [row1, row2] };
}

// ===================================================================
// 11. /MODELS SERVER DASHBOARD BUILDER (Requirement #7)
// ===================================================================
async function buildServerModelsView(guildId, selectedSessionId = null) {
  const sessions = await ArchitectSession.find({ guildId }).sort({ createdAt: -1 }).limit(20);

  const embed = new EmbedBuilder()
    .setTitle('🗂️ Server AI Models, Linked Threads & Slash Command Manager')
    .setDescription(
      sessions.length === 0
        ? 'No models have been created or cloned in this server yet. Run `/architect` or `/public` to get started!'
        : `Managing **${sessions.length}** model(s) in this server.\n*(Note: Deleting a model's thread in Discord automatically deletes its function and unregisters its \`/command\`!)*`
    )
    .setColor('#2ecc71');

  sessions.slice(0, 10).forEach((s, i) => {
    const cmdStatus = s.wantsSlashCommand
      ? s.slashCommandEnabled
        ? `✅ \`/${s.compiledSystem?.commandConfig?.name || 'cmd'}\` (Enabled)`
        : `⏸️ \`/${s.compiledSystem?.commandConfig?.name || 'cmd'}\` (Disabled)`
      : '➖ No `/command`';

    embed.addFields({
      name: `${i + 1}.${s.systemName} (\`#${s.sessionId}\` • v${s.compiledSystem?.version || 0})`,
      value:
        `🧵 **Thread:** ${s.threadId ? `<#${s.threadId}>` : '*None*'} • **Status:** \`${s.status}\`\n` +
        `⚡ **Slash Command:** ${cmdStatus} • 📊 **Runs:** \`${(s.telemetry?.totalInteractionsHandled || 0) + (s.telemetry?.totalSlashRuns || 0)}\``
    });
  });

  const rows = [];
  if (sessions.length > 0) {
    const activeTarget = sessions.find(s => s.sessionId === selectedSessionId) || sessions[0];

    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('srvmod_select')
          .setPlaceholder(`Selected: ${activeTarget.systemName} (#${activeTarget.sessionId})`)
          .addOptions(
            sessions.slice(0, 20).map(s => ({
              label: `${s.systemName} (#${s.sessionId})`.slice(0, 95),
              description: `v${s.compiledSystem?.version || 0} | ${s.status} | Slash Cmd:${s.slashCommandEnabled ? 'Enabled' : 'Disabled'}`.slice(0, 95),
              value: s.sessionId,
              default: s.sessionId === activeTarget.sessionId
            }))
          )
      )
    );

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`srvmod_togglecmd_${activeTarget.sessionId}`)
          .setLabel(
            activeTarget.slashCommandEnabled
              ? `🔌 Disable /${activeTarget.compiledSystem?.commandConfig?.name || 'cmd'}`
              : `🔌 Enable /${activeTarget.compiledSystem?.commandConfig?.name || 'cmd'}`
          )
          .setStyle(activeTarget.slashCommandEnabled ? ButtonStyle.Secondary : ButtonStyle.Success)
          .setDisabled(!activeTarget.wantsSlashCommand || !activeTarget.compiledSystem?.commandCode),
        new ButtonBuilder()
          .setCustomId(`srvmod_monitor_${activeTarget.sessionId}`)
          .setLabel('📡 Process & DB Monitor')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`srvmod_bugfix_${activeTarget.sessionId}`)
          .setLabel('🩹 Fix Bugs')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`srvmod_redeploy_${activeTarget.sessionId}`)
          .setLabel('🚀 Redeploy Panel')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`srvmod_delete_${activeTarget.sessionId}`)
          .setLabel('🗑️ Delete Model')
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

  return { embeds: [embed], components: rows };
}

// ===================================================================
// 12. MASTER INTERACTION ROUTER
// ===================================================================
client.on('interactionCreate', async interaction => {
  try {
    // ---------------------------------------------------------------
    // A. /architect COMMAND (WITH PRE-THREAD NAMING & SLASH_COMMAND BOOL)
    // ---------------------------------------------------------------
    if (interaction.isChatInputCommand() && interaction.commandName === 'architect') {
      const mode = interaction.options.getString('mode');
      const wantsSlashCommand = interaction.options.getBoolean('slash_command');
      const providedName = interaction.options.getString('name');
      const prompt = interaction.options.getString('prompt') || '';
      const img1 = interaction.options.getAttachment('image_1');
      const img2 = interaction.options.getAttachment('image_2');
      const imageUrls = [img1?.url, img2?.url].filter(Boolean);

      // Requirement #7: Must name the item BEFORE the thread is made!
      if (!providedName || !providedName.trim()) {
        const setupKey = `${interaction.user.id}_${Date.now()}`;
        pendingArchitectSetups.set(setupKey, {
          mode,
          wantsSlashCommand,
          prompt,
          imageUrls
        });

        const nameModal = new ModalBuilder()
          .setCustomId(`archname_${setupKey}`)
          .setTitle('Name Your System Before Building')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('item_name')
                .setLabel('System / Model Name (Required)')
                .setPlaceholder('e.g. Phantomz Escrow Hub, VIP Dropper, RPG Bank...')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(45)
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('item_prompt')
                .setLabel('Initial Instructions for AI')
                .setPlaceholder('Describe what this system & its /command should do...')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(prompt)
                .setRequired(false)
            )
          );

        return interaction.showModal(nameModal);
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return await spawnNamedArchitectThread({
        interaction,
        systemName: providedName,
        mode,
        wantsSlashCommand,
        initialPrompt: prompt,
        imageUrls
      });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('archname_')) {
      const setupKey = interaction.customId.replace('archname_', '');
      const cached = pendingArchitectSetups.get(setupKey) || {
        mode: 'normal',
        wantsSlashCommand: false,
        prompt: '',
        imageUrls: []
      };
      pendingArchitectSetups.delete(setupKey);

      const itemName = interaction.fields.getTextInputValue('item_name');
      const itemPrompt = interaction.fields.getTextInputValue('item_prompt') || cached.prompt;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return await spawnNamedArchitectThread({
        interaction,
        systemName: itemName,
        mode: cached.mode,
        wantsSlashCommand: cached.wantsSlashCommand,
        initialPrompt: itemPrompt,
        imageUrls: cached.imageUrls
      });
    }

    // ---------------------------------------------------------------
    // B. IN-DISCORD LIVE PROCESS & DB MONITOR HANDLERS
    // ---------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('procmon_')) {
      const [, action, sessionId] = interaction.customId.split('_');
      const session = await ArchitectSession.findOne({ sessionId });
      if (!session) return interaction.reply({ content: '❌ Session not found.', flags: MessageFlags.Ephemeral });

      if (action === 'refresh') {
        const view = await buildInDiscordProcessMonitor(session);
        return interaction.update(view);
      }

      if (action === 'wipedb') {
        session.runtimeStore = {};
        session.markModified('runtimeStore');
        await session.save();
        const view = await buildInDiscordProcessMonitor(session);
        return interaction.update(view);
      }

      if (action === 'exportdb') {
        const rawJson = JSON.stringify(session.runtimeStore || {}, null, 2);
        const file = new AttachmentBuilder(Buffer.from(rawJson, 'utf-8'), {
          name: `db-${session.sessionId}.json`
        });
        return interaction.reply({
          content: `📥 **Exported Runtime Database for \`${session.systemName}\`:**`,
          files: [file],
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'editdb') {
        const modal = new ModalBuilder()
          .setCustomId(`procmodal_db_${session.sessionId}`)
          .setTitle(`Set Runtime DB Key (#${session.sessionId})`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('db_key')
                .setLabel('Database Key Name')
                .setPlaceholder('e.g. stock, credits, settings, leaderboard')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('db_val')
                .setLabel('JSON or String Value')
                .setPlaceholder('e.g. ["item1", "item2"] or 500 or {"open": true}')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      if (action === 'delkey') {
        const modal = new ModalBuilder()
          .setCustomId(`procmodal_delkey_${session.sessionId}`)
          .setTitle(`Delete Runtime DB Key (#${session.sessionId})`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('db_key')
                .setLabel('Exact Key Name to Delete')
                .setPlaceholder('e.g. stock')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      if (action === 'bugs') {
        const logs = await BugLog.find({ sessionId: session.sessionId }).sort({ createdAt: -1 }).limit(5);
        const bugEmbed = new EmbedBuilder()
          .setTitle(`🐞 Diagnostic Bug Logs — ${session.systemName}`)
          .setDescription(
            logs.length === 0
              ? '✅ Zero unresolved bugs logged for this system!'
              : logs
                  .map(
                    b =>
                      `**#${b.bugId}** (${b.resolved ? '✅ Resolved' : '🚨 Open'})\n> **Reason:** ${b.unfixableReason || b.aiDiagnosis}\n\`\`\`js\n${String(b.rawError).slice(0, 180)}\n\`\`\``
                  )
                  .join('\n\n')
          )
          .setColor(logs.some(l => !l.resolved) ? '#e74c3c' : '#2ecc71');
        return interaction.reply({ embeds: [bugEmbed], flags: MessageFlags.Ephemeral });
      }

      if (action === 'versions') {
        return handleOpenVersionSelector(interaction, session);
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('procmodal_db_')) {
      const sessionId = interaction.customId.replace('procmodal_db_', '');
      const session = await ArchitectSession.findOne({ sessionId });
      if (!session) return interaction.reply({ content: '❌ Session not found.', flags: MessageFlags.Ephemeral });

      const key = interaction.fields.getTextInputValue('db_key').trim();
      const rawVal = interaction.fields.getTextInputValue('db_val').trim();
      let parsedVal = rawVal;
      try {
        parsedVal = JSON.parse(rawVal);
      } catch (_) {}

      if (!session.runtimeStore || typeof session.runtimeStore !== 'object') session.runtimeStore = {};
      session.runtimeStore[key] = parsedVal;
      session.markModified('runtimeStore');
      await session.save();

      const view = await buildInDiscordProcessMonitor(session);
      return interaction.update(view);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('procmodal_delkey_')) {
      const sessionId = interaction.customId.replace('procmodal_delkey_', '');
      const session = await ArchitectSession.findOne({ sessionId });
      if (!session) return interaction.reply({ content: '❌ Session not found.', flags: MessageFlags.Ephemeral });

      const key = interaction.fields.getTextInputValue('db_key').trim();
      if (session.runtimeStore && typeof session.runtimeStore === 'object') {
        delete session.runtimeStore[key];
        session.markModified('runtimeStore');
        await session.save();
      }
      const view = await buildInDiscordProcessMonitor(session);
      return interaction.update(view);
    }

    // ---------------------------------------------------------------
    // C. VERSION HISTORY ROLLBACK HANDLERS
    // ---------------------------------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ver_restore_')) {
      await interaction.deferUpdate();
      const sessionId = interaction.customId.replace('ver_restore_', '');
      const targetVersion = parseInt(interaction.values[0], 10);
      const session = await ArchitectSession.findOne({ sessionId });
      if (!session) return;

      const snap = (session.versionHistory || []).find(v => v.version === targetVersion);
      if (!snap) return;

      session.compiledSystem = {
        ...session.compiledSystem,
        setupCode: snap.setupCode,
        panelCode: snap.panelCode,
        handlerCode: snap.handlerCode,
        commandConfig: snap.commandConfig,
        commandCode: snap.commandCode,
        version: snap.version,
        lastError: null
      };
      await session.save();

      const thread = interaction.guild.channels.cache.get(session.threadId);
      if (thread) {
        await upsertWorkspaceAndPreview(
          session,
          thread,
          `⏪ **Restored Code Snapshot \`v${snap.version}\`!**`
        );
      }

      return interaction.editReply({
        content: `✅ **Successfully rolled back \`${session.systemName}\` to \`v${snap.version}\`!**`,
        embeds: [],
        components: []
      });
    }

    // ---------------------------------------------------------------
    // D. /models COMMAND & SERVER MODEL CONTROLS (Requirement #7)
    // ---------------------------------------------------------------
    if (interaction.isChatInputCommand() && interaction.commandName === 'models') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const view = await buildServerModelsView(interaction.guild.id);
      return interaction.editReply(view);
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'srvmod_select') {
      await interaction.deferUpdate();
      const view = await buildServerModelsView(interaction.guild.id, interaction.values[0]);
      return interaction.editReply(view);
    }

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('archctl_deploychannel_')) {
      const sessionId = interaction.customId.replace('archctl_deploychannel_', '');
      const session = await ArchitectSession.findOne({ sessionId, guildId: interaction.guild.id });
      if (!session) return interaction.reply({ content: '❌ Model not found.', flags: MessageFlags.Ephemeral });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const targetChannel =
        interaction.guild.channels.cache.get(interaction.values[0]) ||
        (await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null));
      const sent = await deployPanelToChannel(session, interaction.guild, targetChannel);
      const thread = await client.channels.fetch(session.threadId).catch(() => null);
      if (thread?.isThread()) await upsertWorkspaceAndPreview(session, thread);
      return interaction.editReply({
        content: `🚀 **Deployed \`${session.systemName}\` to <#${targetChannel.id}>.** [Jump to panel](${sent.url})`
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith('srvmod_')) {
      const [, action, sessionId] = interaction.customId.split('_');
      const session = await ArchitectSession.findOne({ sessionId, guildId: interaction.guild.id });
      if (!session) {
        return interaction.reply({ content: '❌ Model not found.', flags: MessageFlags.Ephemeral });
      }

      if (action === 'monitor') {
        const monitorView = await buildInDiscordProcessMonitor(session);
        return interaction.reply({ ...monitorView, flags: MessageFlags.Ephemeral });
      }

      if (action === 'bugfix') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const thread = interaction.guild.channels.cache.get(session.threadId) || interaction.channel;
        const res = await triggerDeepBugFix(session, interaction.user.id, 'Triggered from /models manager');
        return interaction.editReply({
          content: limitDiscordContent(res.fixed
            ? `🩹 **Repaired \`${session.systemName}\`!**\n${res.summary}`
            : `⚠️ **Could not auto-fix:**\n${res.summary}`)
        });
      }

      if (action === 'togglecmd') {
        await interaction.deferUpdate();
        const nextState = !session.slashCommandEnabled;
        await syncGuildSlashCommand(interaction.guild, session, nextState);
        const view = await buildServerModelsView(interaction.guild.id, session.sessionId);
        return interaction.editReply(view);
      }

      if (action === 'redeploy') {
        return interaction.reply(buildDeployChannelPrompt(session));
      }

      if (action === 'delete') {
        await interaction.deferUpdate();
        await cleanupAndDeleteSession(interaction.guild, session, true);
        const view = await buildServerModelsView(interaction.guild.id);
        return interaction.editReply(view);
      }
    }

    // ---------------------------------------------------------------
    // E. /public MARKETPLACE, RATINGS, REVIEWS, TIPS & TIERS (Req #1 & #2)
    // ---------------------------------------------------------------
    if (interaction.isChatInputCommand() && interaction.commandName === 'public') {
      await interaction.deferReply();
      const view = await buildPublicMarketplaceView(interaction.user.id, 'promoted', 0, '', 'ALL');
      return interaction.editReply(view);
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('pub_cat_')) {
      await interaction.deferUpdate();
      const sortBy = interaction.customId.replace('pub_cat_', '');
      const categoryFilter = interaction.values[0];
      const view = await buildPublicMarketplaceView(interaction.user.id, sortBy, 0, '', categoryFilter);
      return interaction.editReply(view);
    }

    if (interaction.isButton() && (interaction.customId.startsWith('pub_sort_') || interaction.customId.startsWith('pub_page_'))) {
      await interaction.deferUpdate();
      const parts = interaction.customId.split('_');
      const sortBy = parts[2];
      const page = parseInt(parts[3], 10) || 0;
      const categoryFilter = parts[4] || 'ALL';
      const view = await buildPublicMarketplaceView(interaction.user.id, sortBy, page, '', categoryFilter);
      return interaction.editReply(view);
    }

    if (interaction.isButton() && interaction.customId === 'pub_search_modal') {
      const modal = new ModalBuilder()
        .setCustomId('pub_search_submit')
        .setTitle('Search Public AI Models')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('q')
              .setLabel('Keyword or System Name (Leave blank to reset)')
              .setPlaceholder('e.g. Ticket, Shop, Economy, Verification...')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
          )
        );
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'pub_search_submit') {
      await interaction.deferUpdate();
      const q = interaction.fields.getTextInputValue('q').trim();
      const view = await buildPublicMarketplaceView(interaction.user.id, 'promoted', 0, q, 'ALL');
      return interaction.editReply(view);
    }

    if (interaction.isButton() && interaction.customId === 'pub_leaderboard') {
      const topModels = await PublicModel.find().sort({ score: -1, installsCount: -1 }).limit(10);
      const lbEmbed = new EmbedBuilder()
        .setTitle('🏆 Top Rated Public Models & Architects')
        .setDescription(
          topModels.length === 0
            ? 'No models ranked yet!'
            : topModels
                .map(
                  (m, i) =>
                    `**#${i + 1}${m.name}** (\`${m.category}\`) by **${m.authorTag}** — Score: \`${m.score}\` (👍 ${m.upvoterIds.length} | 📥 ${m.installsCount} clones | 🎁 ${m.tipsReceived || 0} Cr)`
                )
                .join('\n')
        )
        .setColor('#f1c40f');
      return interaction.reply({ embeds: [lbEmbed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId === 'pub_claim_daily') {
      const profile = await getOrCreateProfile(interaction.user.id);
      const now = Date.now();
      if (
        !isOwner(interaction.user.id) &&
        profile.lastDailyClaim &&
        now - profile.lastDailyClaim.getTime() < 24 * 60 * 60 * 1000
      ) {
        return interaction.reply({
          content: '⏳ You already claimed your daily credits in the last 24 hours!',
          flags: MessageFlags.Ephemeral
        });
      }
      profile.dailyStreak = (profile.dailyStreak || 0) + 1;
      const streakBonus = Math.min(50, profile.dailyStreak * 5);
      const totalReward = 75 + streakBonus;
      profile.lastDailyClaim = new Date();
      await profile.save();

      const updated = await adjustUserCredits(
        interaction.user.id,
        totalReward,
        `Daily Claim (${profile.dailyStreak}d Streak)`
      );

      return interaction.reply({
        content: `🪙 **+${totalReward} Credits Claimed!** (75 Base +${streakBonus} Streak Bonus) • New Balance: **\`${updated.credits} Cr\`**.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.isButton() && interaction.customId === 'pub_open_tiers') {
      const profile = await getOrCreateProfile(interaction.user.id);
      const ledgerStr =
        (profile.creditLedger || [])
          .slice(0, 5)
          .map(l => `• \`${l.amount >= 0 ? '+' : ''}${l.amount} Cr\` — ${l.reason}`)
          .join('\n') || '• No recent transactions.';

      const tiersEmbed = new EmbedBuilder()
        .setTitle('💎 Architect Membership Tiers & Credit Wallet')
        .setDescription(
          `Your Current Tier: **${TIER_LIMITS[profile.tier].emoji}${TIER_LIMITS[profile.tier].name}** | Balance: **\`${profile.credits} Cr\`**\n\n` +
          `🥉 **Free Tier:** 2 Models/day • 2 Public Clones/day • 10 Edits/model • 3 Version Saves\n` +
          `🥈 **Silver Tier (FREE by joining our Server or 250 Cr):** 5 Models/day • 5 Clones/day • 25 Edits/model • 15% Promo Discount\n` +
          `🥇 **Gold Tier (600 Cr):** 15 Models/day • 15 Clones/day • 60 Edits/model • 35% Promo Discount\n` +
          `💎 **Premium Tier (1,500 Cr):** Unlimited Models • Unlimited Clones • Unlimited Edits & Free Promotions`
        )
        .addFields({ name: '🧾 Recent Credit Transactions', value: ledgerStr })
        .setColor('#f1c40f');

      const tierRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('tier_buy_SILVER_join')
          .setLabel('🎁 Claim Free Silver (Server Member)')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('tier_buy_SILVER_credits')
          .setLabel('🥈 Buy Silver (250 Cr)')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('tier_buy_GOLD_credits')
          .setLabel('🥇 Buy Gold (600 Cr)')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('tier_buy_PREMIUM_credits')
          .setLabel('💎 Buy Premium (1500 Cr)')
          .setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({ embeds: [tiersEmbed], components: [tierRow], flags: MessageFlags.Ephemeral });
    }

    if (interaction.isButton() && interaction.customId.startsWith('tier_buy_')) {
      const [, , targetTier, method] = interaction.customId.split('_');
      const profile = await getOrCreateProfile(interaction.user.id);

      if (method === 'join') {
        if (process.env.SUPPORT_SERVER_ID) {
          const sGuild = client.guilds.cache.get(process.env.SUPPORT_SERVER_ID);
          const isMember = sGuild ? await sGuild.members.fetch(interaction.user.id).catch(() => null) : null;
          if (!isOwner(interaction.user.id) && !isMember) {
            return interaction.reply({
              content: '❌ You must join our official community server first to claim Free Silver Tier!',
              flags: MessageFlags.Ephemeral
            });
          }
        }
        if (profile.tier === 'FREE') profile.tier = 'SILVER';
        profile.claimedServerSilver = true;
        await profile.save();
        return interaction.reply({
          content: '🥈 **Silver Tier Unlocked!** You now get 5 daily builds, 5 public clones, and 25 AI edits per model.',
          flags: MessageFlags.Ephemeral
        });
      }

      const cost = TIER_LIMITS[targetTier].cost;
      if (!isOwner(interaction.user.id) && profile.credits < cost) {
        return interaction.reply({
          content: `❌ You need **${cost} Cr** for **${targetTier}** (You have \`${profile.credits} Cr\`). Earn credits by publishing models that get 👍 upvotes or claiming daily credits!`,
          flags: MessageFlags.Ephemeral
        });
      }

      profile.tier = targetTier;
      await profile.save();
      const updated = isOwner(interaction.user.id)
        ? profile
        : await adjustUserCredits(interaction.user.id, -cost, `Purchased ${targetTier} Tier`);

      return interaction.reply({
        content: `🎉 **Upgraded to ${TIER_LIMITS[targetTier].emoji}${TIER_LIMITS[targetTier].name} Tier!** Remaining balance: \`${updated.credits} Cr\`.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.isButton() && interaction.customId === 'pub_publish_picker') {
      const mySessions = await ArchitectSession.find({
        creatorId: interaction.user.id,
        'compiledSystem.panelCode': { $ne: '' }
      }).sort({ updatedAt: -1 }).limit(15);

      if (mySessions.length === 0) {
        return interaction.reply({
          content: '❌ You have no compiled models yet! Run `/architect` first.',
          flags: MessageFlags.Ephemeral
        });
      }

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('pub_do_publish')
          .setPlaceholder('Select one of your models to publish to /public...')
          .addOptions(
            mySessions.map(s => ({
              label: s.systemName.slice(0, 95),
              description: `v${s.compiledSystem?.version || 1} | ${s.wantsSlashCommand ? 'Includes /command' : 'Panel System'}`,
              value: s.sessionId
            }))
          )
      );

      return interaction.reply({
        content: '📤 **Choose a model to publish to the `/public` Marketplace:**',
        components: [selectRow],
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'pub_do_publish') {
      const session = await ArchitectSession.findOne({ sessionId: interaction.values[0] });
      if (!session) return interaction.reply({ content: '❌ Session not found.', flags: MessageFlags.Ephemeral });

      const pubDoc = await publishSessionToPublic(session, interaction.user);
      return interaction.update({
        content: `✅ **Published \`${pubDoc.name}\` to \`/public\` (ID: \`${pubDoc.publicId}\`)!** Every 👍 Good rating from the community earns you **+15 Credits**!`,
        components: []
      });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'pub_select_model') {
      const pubModel = await PublicModel.findOne({ publicId: interaction.values[0] });
      if (!pubModel) return interaction.reply({ content: '❌ Model not found.', flags: MessageFlags.Ephemeral });

      return interaction.reply({
        ...buildPublicModelDetailCard(pubModel),
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith('pubact_')) {
      const [, action, publicId] = interaction.customId.split('_');
      const pubModel = await PublicModel.findOne({ publicId });
      if (!pubModel) return interaction.reply({ content: '❌ Model not found.', flags: MessageFlags.Ephemeral });

      if (action === 'good' || action === 'bad') {
        const alreadyUpvoted = pubModel.upvoterIds.includes(interaction.user.id);
        pubModel.upvoterIds = pubModel.upvoterIds.filter(id => id !== interaction.user.id);
        pubModel.downvoterIds = pubModel.downvoterIds.filter(id => id !== interaction.user.id);

        if (action === 'good') {
          pubModel.upvoterIds.push(interaction.user.id);
          if (!alreadyUpvoted && pubModel.authorId !== interaction.user.id) {
            await adjustUserCredits(pubModel.authorId, 15, `👍 Upvote on "${pubModel.name}"`);
          }
        } else {
          pubModel.downvoterIds.push(interaction.user.id);
        }

        pubModel.score = pubModel.upvoterIds.length - pubModel.downvoterIds.length;
        await pubModel.save();
        return interaction.update(buildPublicModelDetailCard(pubModel));
      }

      if (action === 'review') {
        const modal = new ModalBuilder()
          .setCustomId(`pubreview_${pubModel.publicId}`)
          .setTitle(`Review ${pubModel.name}`.slice(0, 45))
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('comment')
                .setLabel('Your Review / Feedback')
                .setPlaceholder('What did you like or dislike about this system?')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(250)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      if (action === 'tip') {
        if (pubModel.authorId === interaction.user.id) {
          return interaction.reply({ content: '❌ You cannot tip yourself!', flags: MessageFlags.Ephemeral });
        }
        const profile = await getOrCreateProfile(interaction.user.id);
        if (!isOwner(interaction.user.id) && profile.credits < 50) {
          return interaction.reply({ content: '❌ You need at least **50 Cr** to tip a creator.', flags: MessageFlags.Ephemeral });
        }
        if (!isOwner(interaction.user.id)) {
          await adjustUserCredits(interaction.user.id, -50, `Tipped ${pubModel.authorTag}`);
        }
        await adjustUserCredits(pubModel.authorId, 50, `Tip received on "${pubModel.name}"`);
        pubModel.tipsReceived = (pubModel.tipsReceived || 0) + 50;
        await pubModel.save();
        return interaction.update(buildPublicModelDetailCard(pubModel));
      }

      if (action === 'inspect') {
        const previewCode = [
          `// PUBLIC MODEL: ${pubModel.name} (#${pubModel.publicId}) by${pubModel.authorTag}`,
          `// --- PANEL CODE ---\n${pubModel.compiledSystem?.panelCode || '// None'}`,
          `\n// --- HANDLER CODE ---\n${pubModel.compiledSystem?.handlerCode || '// None'}`,
          `\n// --- SLASH COMMAND CODE ---\n${pubModel.compiledSystem?.commandCode || '// None'}`
        ].join('\n');

        const file = new AttachmentBuilder(Buffer.from(previewCode, 'utf-8'), {
          name: `public-${pubModel.publicId}.js`
        });
        return interaction.reply({
          content: `💻 **Source Code Inspection for \`${pubModel.name}\`:**`,
          files: [file],
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'promote') {
        const profile = await getOrCreateProfile(interaction.user.id);
        const discount = TIER_LIMITS[profile.tier]?.promoDiscount || 0;
        const effectiveCost = isOwner(interaction.user.id) ? 0 : Math.max(0, 100 - discount);

        if (profile.credits < effectiveCost) {
          return interaction.reply({
            content: `❌ Promoting costs **${effectiveCost} Credits** for your tier (You have \`${profile.credits} Cr\`).`,
            flags: MessageFlags.Ephemeral
          });
        }
        if (effectiveCost > 0) {
          await adjustUserCredits(interaction.user.id, -effectiveCost, `Promoted "${pubModel.name}"`);
        }
        pubModel.promotedCreditsSpent += 100;
        pubModel.promotedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await pubModel.save();
        return interaction.update(buildPublicModelDetailCard(pubModel));
      }

      if (action === 'clone') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const profile = await getOrCreateProfile(interaction.user.id);
        const tierSpec = TIER_LIMITS[profile.tier];

        if (!isOwner(interaction.user.id) && profile.dailyStats.publicModelsUsed >= tierSpec.dailyPublicUses) {
          return interaction.editReply({
            content: `⛔ **Daily Public Clone Limit Reached (${tierSpec.dailyPublicUses}/day for${tierSpec.name} Tier)!** Upgrade your tier in \`/public\` to clone more models.`
          });
        }

        profile.dailyStats.publicModelsUsed += 1;
        await profile.save();

        pubModel.installsCount += 1;
        await pubModel.save();

        const newSessionId = Math.random().toString(36).substring(2, 8);
        const thread = await interaction.channel.threads.create({
          name: `📦-${pubModel.name}-${newSessionId}`.slice(0, 95),
          autoArchiveDuration: 60,
          reason: `Cloned Public Model #${pubModel.publicId}`
        });

        const clonedSession = await ArchitectSession.create({
          sessionId: newSessionId,
          guildId: interaction.guild.id,
          creatorId: interaction.user.id,
          threadId: thread.id,
          systemName: pubModel.name,
          category: pubModel.category || 'Multi-System',
          mode: 'normal',
          status: 'COMPILED',
          wantsSlashCommand: Boolean(pubModel.hasSlashCommand),
          forkedFromPublicId: pubModel.publicId,
          compiledSystem: {
            ...pubModel.compiledSystem,
            version: 1,
            lastError: null
          },
          deployedResources: {
            panelChannelId: interaction.channel.id,
            createdChannelIds: [],
            createdRoleIds: []
          }
        });

        await saveVersionSnapshot(clonedSession, 10);
        await clonedSession.save();

        if (clonedSession.wantsSlashCommand && clonedSession.compiledSystem?.commandCode) {
          await syncGuildSlashCommand(interaction.guild, clonedSession, true);
        }

        await upsertWorkspaceAndPreview(
          clonedSession,
          thread,
          `📦 **Cloned from \`/public\` (\`#${pubModel.publicId}\` by ${pubModel.authorTag})!**\n` +
          (clonedSession.slashCommandEnabled
            ? `⚡ Custom server command \`/${clonedSession.compiledSystem.commandConfig.name}\` has also been registered in this server!`
            : '')
        );

        return interaction.editReply({
          content: `✅ **Cloned \`${pubModel.name}\` into <#${thread.id}>!** ${
            clonedSession.slashCommandEnabled
              ? `Its slash command \`/${clonedSession.compiledSystem.commandConfig.name}\` is now live in this server!`
              : ''
          }`
        });
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('pubreview_')) {
      const publicId = interaction.customId.replace('pubreview_', '');
      const pubModel = await PublicModel.findOne({ publicId });
      if (!pubModel) return interaction.reply({ content: '❌ Model not found.', flags: MessageFlags.Ephemeral });

      const comment = interaction.fields.getTextInputValue('comment').trim();
      const isDownvoter = pubModel.downvoterIds.includes(interaction.user.id);
      pubModel.reviews.push({
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        rating: isDownvoter ? 'BAD' : 'GOOD',
        comment
      });
      await pubModel.save();
      return interaction.update(buildPublicModelDetailCard(pubModel));
    }

    // ---------------------------------------------------------------
    // F. WORKSPACE THREAD CONTROLS (Deploy, Fix Bugs, Monitor, Versions, Publish, Toggle /cmd, Rollback)
    // ---------------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('archctl_')) {
      const [, action, sessionId] = interaction.customId.split('_');
      const session = await ArchitectSession.findOne({ sessionId });
      if (!session) return interaction.reply({ content: '❌ Session not found.', flags: MessageFlags.Ephemeral });

      if (action === 'testpanel') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const thread = await client.channels.fetch(session.threadId);
        if (!thread?.isThread()) throw new Error('The system workspace thread could not be found.');
        const preview = await updateTestPanelPreview(session, thread);
        return interaction.editReply({
          content: `🧪 **Test panel deployed to this workspace:** [Jump to preview](${preview.url})`
        });
      }

      if (action === 'monitor') {
        const monitorView = await buildInDiscordProcessMonitor(session);
        return interaction.reply({ ...monitorView, flags: MessageFlags.Ephemeral });
      }

      if (action === 'versions') {
        return handleOpenVersionSelector(interaction, session);
      }

      if (action === 'forcecompile') {
        await interaction.deferUpdate();
        session.conversation.push({ role: 'user', content: 'Compile the complete system now.' });
        await processTurnInPlace(session, interaction.channel, true);
        return;
      }

      if (action === 'bugfix') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await triggerDeepBugFix(session, interaction.user.id, 'User clicked Fix Bugs button');
        return interaction.editReply({
          content: limitDiscordContent(result.fixed
            ? `🩹 **Fixed & Updated In-Place!**\n${result.summary}`
            : `⚠️ **Unresolved issue posted in the system thread:**\n${result.summary}`)
        });
      }

      if (action === 'togglecmd') {
        await interaction.deferUpdate();
        const nextState = !session.slashCommandEnabled;
        await syncGuildSlashCommand(interaction.guild, session, nextState);
        await upsertWorkspaceAndPreview(session, interaction.channel);
        return;
      }

      if (action === 'publish') {
        const pubDoc = await publishSessionToPublic(session, interaction.user);
        return interaction.reply({
          content: `🌐 **Published \`${pubDoc.name}\` to \`/public\` (ID: \`${pubDoc.publicId}\`)!** People can now rate, review, promote, and clone it.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === 'code') {
        const fullSource = [
          `// SYSTEM: ${session.systemName} (v${session.compiledSystem.version})`,
          `// --- SETUP CODE ---\n${session.compiledSystem.setupCode || '// None'}`,
          `\n// --- PANEL CODE ---\n${session.compiledSystem.panelCode || '// None'}`,
          `\n// --- HANDLER CODE ---\n${session.compiledSystem.handlerCode || '// None'}`,
          `\n// --- SLASH COMMAND CODE (/${session.compiledSystem.commandConfig?.name || 'none'}) ---\n${session.compiledSystem.commandCode || '// None'}`
        ].join('\n');

        const file = new AttachmentBuilder(Buffer.from(fullSource, 'utf-8'), {
          name: `${session.systemName.replace(/[^a-z0-9]/gi, '_')}-v${session.compiledSystem.version}.js`
        });
        return interaction.reply({ content: '💻 **Synthesized System Source Code:**', files: [file], flags: MessageFlags.Ephemeral });
      }

      if (action === 'deploy') {
        return interaction.reply(buildDeployChannelPrompt(session));
      }

      if (action === 'rollback') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await rollbackDeployedResources(interaction.guild, session);
        await upsertWorkspaceAndPreview(session, interaction.channel);
        return interaction.editReply({ content: '⏪ **Undeployed & Cleaned Up!**' });
      }
    }

    // ---------------------------------------------------------------
    // G. EXECUTE CUSTOM GUILD SLASH COMMANDS (Requirement #4)
    // ---------------------------------------------------------------
    if (interaction.isChatInputCommand() && !['architect', 'models', 'public'].includes(interaction.commandName)) {
      const session = await ArchitectSession.findOne({
        guildId: interaction.guild.id,
        slashCommandEnabled: true,
        'compiledSystem.commandConfig.name': interaction.commandName
      });

      if (!session || !session.compiledSystem?.commandCode) {
        return interaction.reply({
          content: '⚠️ This dynamic slash command is currently disabled or its model was removed.',
          flags: MessageFlags.Ephemeral
        });
      }

      session.telemetry = {
        ...(session.telemetry || {}),
        totalSlashRuns: (session.telemetry?.totalSlashRuns || 0) + 1,
        lastActiveAt: new Date()
      };
      await session.save();

      try {
        const result = await executeAiCodeBlock({
          session,
          code: session.compiledSystem.commandCode,
          guild: interaction.guild,
          channel: interaction.channel,
          interaction,
          cleanCustomId: interaction.commandName
        });
        if (!interaction.deferred && !interaction.replied) {
          const replyPayload =
            result == null
              ? { content: `✅ \`/${interaction.commandName}\` completed.` }
              : normalizeGeneratedMessagePayload(result);
          await interaction.reply(replyPayload);
        }
      } catch (cmdErr) {
        session.compiledSystem.lastError = `Slash /${interaction.commandName} Error:${cmdErr.stack || cmdErr.message}`;
        await session.save();
        const systemThread = await client.channels.fetch(session.threadId).catch(() => null);
        if (systemThread?.isThread()) {
          await systemThread
            .send(`⚠️ **Slash command error (\`/${interaction.commandName}\`):** ${String(cmdErr.message || cmdErr).slice(0, 1200)}`)
            .catch(sendErr => console.error('[Slash Command Error Report]:', sendErr));
          await upsertWorkspaceAndPreview(session, systemThread);
        }
        const errReply = {
          content: `❌ **Command Error in \`/${interaction.commandName}\`:** \`${cmdErr.message}\`\nRun \`!bug\` or click **🩹 Fix Bugs** in <#${session.threadId}> to auto-repair it!`,
          flags: MessageFlags.Ephemeral
        };
        if (interaction.deferred || interaction.replied) await interaction.followUp(errReply).catch(() => {});
        else await interaction.reply(errReply).catch(() => {});
      }
      return;
    }

    // ---------------------------------------------------------------
    // H. UNIVERSAL DYNAMIC COMPONENT ROUTER (dyn_<sessionId>_<customId>)
    // ---------------------------------------------------------------
    if (
      (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) &&
      interaction.customId.startsWith('dyn_')
    ) {
      const parts = interaction.customId.split('_');
      const sessionId = parts[1];
      const cleanCustomId = parts.slice(2).join('_');

      const session = await ArchitectSession.findOne({ sessionId });
      if (!session || !session.compiledSystem?.handlerCode) {
        return interaction.reply({ content: '⚠️ System session no longer exists.', flags: MessageFlags.Ephemeral });
      }

      session.telemetry = {
        ...(session.telemetry || {}),
        totalInteractionsHandled: (session.telemetry?.totalInteractionsHandled || 0) + 1,
        lastActiveAt: new Date()
      };
      await session.save();

      try {
        await executeAiCodeBlock({
          session,
          code: session.compiledSystem.handlerCode,
          guild: interaction.guild,
          channel: interaction.channel,
          interaction,
          cleanCustomId
        });
      } catch (runtimeErr) {
        session.compiledSystem.lastError = `Handler Error on "${cleanCustomId}": ${runtimeErr.stack || runtimeErr.message}`;
        await session.save();

        const errMsg = {
          content: `❌ **Runtime Bug on \`${cleanCustomId}\`:** \`${runtimeErr.message}\`\nType \`!bug\` or click **🩹 Fix Bugs** in <#${session.threadId}> to auto-heal!`,
          flags: MessageFlags.Ephemeral
        };
        if (interaction.deferred || interaction.replied) await interaction.followUp(errMsg).catch(() => {});
        else await interaction.reply(errMsg).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[Interaction Error]:', err);
    const msg = {
      content: limitDiscordContent(`❌ **Error:** \`${err.message}\``),
      flags: MessageFlags.Ephemeral
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// ===================================================================
// 13. LIVE THREAD CHAT & `!bug` COMMAND HANDLER (Requirement #5 & #6)
// ===================================================================
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const session = await ArchitectSession.findOne({ threadId: message.channel.id });
  if (!session) return;

  try {
    const content = message.content.trim();
    const imageUrls = Array.from(message.attachments.values())
      .filter(a => a.contentType?.startsWith('image/'))
      .map(a => a.url);

    if (!content && imageUrls.length === 0) {
      return message.reply('Please send a text instruction or attach an image to update this system.');
    }

    if (content.toLowerCase().startsWith('!bug')) {
      const bugNote = content.slice(4).trim();
      await message.delete().catch(() => {});
      const statusMsg = await message.channel.send(
        '🩹 **Running forensic bug diagnosis across panel, handlers, and `/command`...**'
      );
      await triggerDeepBugFix(session, message.author.id, bugNote);
      setTimeout(() => statusMsg.delete().catch(() => {}), 2500);
      return;
    }

    const profile = await getOrCreateProfile(message.author.id);
    const tierSpec = TIER_LIMITS[profile.tier];
    if (!isOwner(message.author.id) && session.editsUsed >= tierSpec.maxEditsPerModel) {
      return message.reply(
        `⛔ **Edit Limit Reached (${tierSpec.maxEditsPerModel} edits/model on${tierSpec.name} Tier)!** Upgrade your tier via \`/public\` to unlock more edits.`
      );
    }

    session.editsUsed += 1;
    session.conversation.push({
      role: 'user',
      content: content || 'Update system based on attached image.',
      imageUrls
    });
    await session.save();

    if (imageUrls.length === 0) {
      await message.delete().catch(() => {});
    }

    await processTurnInPlace(session, message.channel, false);
  } catch (err) {
    console.error('[Thread Message Error]:', err);
    await message.channel.send(`❌ **AI Update Error:** \`${err.message}\``).catch(() => {});
  }
});

// ===================================================================
// 14. AUTOMATIC CLEANUP WHEN THREAD IS DELETED (Requirement #7)
// ===================================================================
client.on('threadDelete', async thread => {
  try {
    const session = await ArchitectSession.findOne({ threadId: thread.id });
    if (!session) return;

    console.log(`🗑️ [Thread Deleted] Auto-cleaning model "${session.systemName}" (#${session.sessionId})`);
    await cleanupAndDeleteSession(thread.guild, session, false);
  } catch (err) {
    console.error('[threadDelete Cleanup Error]:', err);
  }
});

// ===================================================================
// 15. HELPER FUNCTIONS: VERSION SELECTOR, PUBLISH & CLEANUP
// ===================================================================
async function handleOpenVersionSelector(interaction, session) {
  const history = session.versionHistory || [];
  if (history.length === 0) {
    return interaction.reply({
      content: 'ℹ️ No version snapshots saved yet.',
      flags: MessageFlags.Ephemeral
    });
  }

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ver_restore_${session.sessionId}`)
      .setPlaceholder('⏪ Select a saved code version to restore...')
      .addOptions(
        history
          .slice()
          .reverse()
          .slice(0, 15)
          .map(v => ({
            label: `Version v${v.version} (${new Date(v.savedAt).toLocaleTimeString()})`,
            description: (v.summary || 'Saved snapshot').slice(0, 90),
            value: String(v.version)
          }))
      )
  );

  return interaction.reply({
    content: `⏪ **Version History for \`${session.systemName}\`** — Select any snapshot below to roll back immediately:`,
    components: [selectRow],
    flags: MessageFlags.Ephemeral
  });
}

async function publishSessionToPublic(session, user) {
  const publicId = session.publicModelId || Math.random().toString(36).substring(2, 8);
  const pubDoc = await PublicModel.findOneAndUpdate(
    { publicId },
    {
      publicId,
      sourceSessionId: session.sessionId,
      authorId: user.id,
      authorTag: user.tag,
      originGuildId: session.guildId,
      name: session.systemName,
      category: session.category || 'Multi-System',
      description: (session.compiledSystem?.summary || `AI-built ${session.systemName} system`).slice(0, 300),
      hasSlashCommand: Boolean(session.wantsSlashCommand && session.compiledSystem?.commandCode),
      compiledSystem: session.compiledSystem
    },
    { upsert: true, new: true }
  );

  session.publicModelId = publicId;
  await session.save();
  return pubDoc;
}

async function rollbackDeployedResources(guild, session) {
  if (!guild) return;
  for (const chId of session.deployedResources?.createdChannelIds || []) {
    const ch = guild.channels.cache.get(chId);
    if (ch) await ch.delete('Architect Rollback').catch(() => {});
  }
  for (const rId of session.deployedResources?.createdRoleIds || []) {
    const r = guild.roles.cache.get(rId);
    if (r) await r.delete('Architect Rollback').catch(() => {});
  }
  if (session.deployedResources?.panelChannelId && session.deployedResources?.panelMessageId) {
    const ch = guild.channels.cache.get(session.deployedResources.panelChannelId);
    if (ch) {
      const msg = await ch.messages.fetch(session.deployedResources.panelMessageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    }
  }
  session.status = 'COMPILED';
  session.deployedResources.panelMessageId = null;
  session.deployedResources.createdChannelIds = [];
  session.deployedResources.createdRoleIds = [];
  await session.save();
}

async function cleanupAndDeleteSession(guild, session, deleteThreadToo = false) {
  await rollbackDeployedResources(guild, session);
  await syncGuildSlashCommand(guild, session, false);

  if (deleteThreadToo && session.threadId && guild) {
    const th = guild.channels.cache.get(session.threadId);
    if (th) await th.delete('Model deleted via /models').catch(() => {});
  }

  await ArchitectSession.deleteOne({ sessionId: session.sessionId });
}

// ===================================================================
// 16. BOOTSTRAP BOT & GLOBAL SLASH COMMANDS
// ===================================================================
client.once('clientReady', async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`✅ Connected to MongoDB & Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
    body: coreCommands.map(cmd => cmd.toJSON())
  });
  console.log('⚡ Registered Global Commands: [/architect, /models, /public]');
});

client.login(process.env.DISCORD_TOKEN);