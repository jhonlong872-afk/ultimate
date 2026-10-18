const mongoose = require('mongoose');

// ===================================================================
// 1. MEMBERSHIP TIERS & QUOTA CONFIGURATION (Requirement #2)
// ===================================================================
const TIER_LIMITS = {
  FREE: {
    name: 'Free',
    emoji: '🥉',
    dailyModels: 2,
    dailyPublicUses: 2,
    maxEditsPerModel: 10,
    maxVersionHistory: 3,
    promoDiscount: 0,
    cost: 0
  },
  SILVER: {
    name: 'Silver',
    emoji: '🥈',
    dailyModels: 5,
    dailyPublicUses: 5,
    maxEditsPerModel: 25,
    maxVersionHistory: 5,
    promoDiscount: 15,
    cost: 250
  },
  GOLD: {
    name: 'Gold',
    emoji: '🥇',
    dailyModels: 15,
    dailyPublicUses: 15,
    maxEditsPerModel: 60,
    maxVersionHistory: 10,
    promoDiscount: 35,
    cost: 600
  },
  PREMIUM: {
    name: 'Premium',
    emoji: '💎',
    dailyModels: 999,
    dailyPublicUses: 999,
    maxEditsPerModel: 999,
    maxVersionHistory: 20,
    promoDiscount: 100,
    cost: 1500
  }
};

// ===================================================================
// 2. USER PROFILE, STREAKS & CREDIT LEDGER SCHEMA
// ===================================================================
const UserProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  tier: { type: String, enum: ['FREE', 'SILVER', 'GOLD', 'PREMIUM'], default: 'FREE' },
  credits: { type: Number, default: 125 },
  totalCreditsEarned: { type: Number, default: 125 },
  totalCreditsSpent: { type: Number, default: 0 },
  claimedServerSilver: { type: Boolean, default: false },
  dailyStreak: { type: Number, default: 0 },
  lastDailyClaim: { type: Date, default: null },

  dailyStats: {
    dateKey: { type: String, default: () => new Date().toISOString().slice(0, 10) },
    modelsCreated: { type: Number, default: 0 },
    publicModelsUsed: { type: Number, default: 0 },
    bugsFixed: { type: Number, default: 0 }
  },

  creditLedger: [
    {
      amount: Number,
      reason: String,
      timestamp: { type: Date, default: Date.now }
    }
  ]
}, { timestamps: true });

// ===================================================================
// 3. ARCHITECT SESSION, VERSION SNAPSHOTS & IN-DISCORD TELEMETRY
// ===================================================================
const CodeSnapshotSchema = new mongoose.Schema({
  version: { type: Number, required: true },
  summary: { type: String, default: '' },
  setupCode: { type: String, default: '' },
  panelCode: { type: String, default: '' },
  handlerCode: { type: String, default: '' },
  commandConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
  commandCode: { type: String, default: '' },
  savedAt: { type: Date, default: Date.now }
}, { _id: false });

const ArchitectSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  guildId: { type: String, required: true, index: true },
  creatorId: { type: String, required: true, index: true },
  threadId: { type: String, index: true },
  systemName: { type: String, required: true },
  category: { type: String, default: 'Multi-System' },
  mode: { type: String, enum: ['autopilot', 'help', 'normal'], default: 'normal' },
  status: { type: String, enum: ['CONVERSING', 'COMPILED', 'DEPLOYED'], default: 'CONVERSING' },
  editsUsed: { type: Number, default: 0 },

  // Custom Guild Slash Command settings (Requirement #4 & #7)
  wantsSlashCommand: { type: Boolean, default: false },
  slashCommandEnabled: { type: Boolean, default: false },
  registeredCommandId: { type: String, default: null },

  // Anti-Clutter Single-Message Tracking IDs (Requirement #6)
  workspaceMessageId: { type: String, default: null },
  previewMessageId: { type: String, default: null },

  // In-Discord Live Process & Telemetry Monitor (100% In-Discord replacement for website)
  telemetry: {
    currentStep: { type: String, default: 'Idle / Ready' },
    processLogs: [{ step: String, timestamp: { type: Date, default: Date.now } }],
    lastProviderUsed: { type: String, default: 'gemini-3.8-flash' },
    lastCompileDurationMs: { type: Number, default: 0 },
    totalInteractionsHandled: { type: Number, default: 0 },
    totalSlashRuns: { type: Number, default: 0 },
    bugFixesRun: { type: Number, default: 0 },
    autoHealsTriggered: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now }
  },

  conversation: [
    {
      role: { type: String, enum: ['user', 'assistant'], required: true },
      content: { type: String, required: true },
      imageUrls: [String],
      timestamp: { type: Date, default: Date.now }
    }
  ],

  compiledSystem: {
    systemName: { type: String, default: 'Untitled AI System' },
    summary: { type: String, default: '' },
    setupCode: { type: String, default: '' },
    panelCode: { type: String, default: '' },
    handlerCode: { type: String, default: '' },
    commandConfig: {
      name: { type: String, default: '' },
      description: { type: String, default: '' },
      options: [
        {
          name: { type: String },
          description: { type: String },
          type: { type: String, enum: ['STRING', 'INTEGER', 'BOOLEAN', 'USER', 'CHANNEL'], default: 'STRING' },
          required: { type: Boolean, default: false }
        }
      ]
    },
    commandCode: { type: String, default: '' },
    version: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    lintWarnings: [String]
  },

  // Stores previous working versions for 1-Click In-Discord Version Rollback
  versionHistory: [CodeSnapshotSchema],

  // Persistent Key-Value Database for the AI's custom system
  runtimeStore: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  deployedResources: {
    panelChannelId: String,
    panelMessageId: String,
    createdChannelIds: [String],
    createdRoleIds: [String]
  },

  publicModelId: { type: String, default: null },
  forkedFromPublicId: { type: String, default: null }
}, { timestamps: true, minimize: false });

// ===================================================================
// 4. PUBLIC MARKETPLACE MODEL SCHEMA (Requirement #1)
// ===================================================================
const PublicModelSchema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, index: true },
  sourceSessionId: { type: String, required: true },
  authorId: { type: String, required: true, index: true },
  authorTag: { type: String, default: 'Unknown Architect' },
  originGuildId: { type: String },
  name: { type: String, required: true },
  description: { type: String, default: 'AI-Engineered Discord System' },
  category: {
    type: String,
    enum: ['Economy', 'Shop', 'Tickets', 'RPG', 'Security', 'Utility', 'Multi-System'],
    default: 'Multi-System',
    index: true
  },
  hasSlashCommand: { type: Boolean, default: false },

  compiledSystem: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },

  upvoterIds: [String],
  downvoterIds: [String],
  score: { type: Number, default: 0, index: true },

  reviews: [
    {
      userId: String,
      userTag: String,
      rating: { type: String, enum: ['GOOD', 'BAD'], default: 'GOOD' },
      comment: String,
      createdAt: { type: Date, default: Date.now }
    }
  ],

  promotedCreditsSpent: { type: Number, default: 0, index: true },
  promotedUntil: { type: Date, default: null },
  installsCount: { type: Number, default: 0, index: true },
  tipsReceived: { type: Number, default: 0 }
}, { timestamps: true });

// ===================================================================
// 5. UNRESOLVED BUG REPORT LOG SCHEMA (Requirement #5)
// ===================================================================
const BugLogSchema = new mongoose.Schema({
  bugId: { type: String, required: true, unique: true, index: true },
  sessionId: { type: String, required: true, index: true },
  guildId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  systemName: { type: String },
  stage: { type: String },
  rawError: { type: String },
  codeSnippet: { type: String, default: '' },
  aiDiagnosis: { type: String },
  resolved: { type: Boolean, default: false, index: true },
  unfixableReason: { type: String, default: null }
}, { timestamps: true });

module.exports = {
  TIER_LIMITS,
  UserProfile: mongoose.model('UserProfile', UserProfileSchema),
  ArchitectSession: mongoose.model('ArchitectSession', ArchitectSessionSchema),
  PublicModel: mongoose.model('PublicModel', PublicModelSchema),
  BugLog: mongoose.model('BugLog', BugLogSchema)
};