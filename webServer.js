const express = require('express');
const { ArchitectSession, PublicModel, BugLog } = require('./models');

function startWebServer(client) {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.get('/', async (req, res) => {
    try {
      const [sessions, publicModels, bugLogs] = await Promise.all([
        ArchitectSession.find().sort({ updatedAt: -1 }).limit(12),
        PublicModel.find().sort({ promotedCreditsSpent: -1, score: -1 }).limit(8),
        BugLog.find({ resolved: false }).sort({ createdAt: -1 }).limit(8)
      ]);

      const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Apex Visual Architect — Live Operations Center</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-[#111214] text-gray-200 p-6 font-sans">
        <div class="max-w-7xl mx-auto space-y-8">
          <div class="flex items-center justify-between border-b border-gray-800 pb-4">
            <div>
              <h1 class="text-2xl font-bold text-white">⚡ Apex Visual Architect — Final v2.0</h1>
              <p class="text-xs text-gray-400">Live Server Systems • Public Marketplace • Self-Healing Debugger</p>
            </div>
            <span class="bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-xs px-3 py-1 rounded-full font-bold">
              ● Online: ${client.user?.tag || 'Booting'}
            </span>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <!-- Active Server Models -->
            <div class="lg:col-span-2 space-y-3">
              <h2 class="text-sm font-bold uppercase tracking-wider text-indigo-400">🛠️ Active Server Systems (${sessions.length})</h2>${sessions.map(s => `
                <div class="bg-[#1e1f22] border border-gray-800 rounded-lg p-4 space-y-2">
                  <div class="flex justify-between items-center">
                    <span class="font-bold text-white">${s.systemName} <span class="text-xs text-gray-400 font-mono">(#${s.sessionId} • v${s.compiledSystem?.version || 0})</span></span>
                    <span class="text-[11px] px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-semibold">${s.status} ${s.slashCommandEnabled ? '• /' + (s.compiledSystem?.commandConfig?.name || 'cmd') : ''}</span>
                  </div>
                  <div class="text-xs text-gray-400">Thread: <code>${s.threadId || 'N/A'}</code> • Mode: <b>${s.mode}</b> • Edits: ${s.editsUsed}</div>
                </div>
              `).join('') || '<div class="text-xs text-gray-500">No systems built yet.</div>'}
            </div>

            <!-- Public Hub & Bug Logs -->
            <div class="space-y-6">
              <div class="space-y-3">
                <h2 class="text-sm font-bold uppercase tracking-wider text-amber-400">🌐 Top Public Models (${publicModels.length})</h2>${publicModels.map(p => `
                  <div class="bg-[#1e1f22] border border-gray-800 rounded-lg p-3 text-xs space-y-1">
                    <div class="flex justify-between font-bold text-white">
                      <span>${p.promotedCreditsSpent > 0 ? '🔥 ' : ''}${p.name}</span>
                      <span class="text-emerald-400">👍 ${p.upvoterIds.length} | 👎 ${p.downvoterIds.length}</span>
                    </div>
                    <div class="text-gray-400">Installs: ${p.installsCount} • Promoted: ${p.promotedCreditsSpent} Cr</div>
                  </div>
                `).join('') || '<div class="text-xs text-gray-500">No public models published yet.</div>'}
              </div>

              <div class="space-y-3">
                <h2 class="text-sm font-bold uppercase tracking-wider text-red-400">🩹 Unresolved Bug Logs (${bugLogs.length})</h2>${bugLogs.map(b => `
                  <div class="bg-red-950/30 border border-red-800/40 rounded-lg p-3 text-xs space-y-1">
                    <div class="font-bold text-red-300">${b.systemName} (#${b.bugId})</div>
                    <div class="text-gray-300 truncate">${b.unfixableReason || b.rawError}</div>
                  </div>
                `).join('') || '<div class="text-xs text-gray-500">Zero unresolved bugs!</div>'}
              </div>
            </div>
          </div>
        </div>
      </body>
      </html>`;
      res.send(html);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.listen(PORT, () => console.log(`🌐 [Web Dashboard] Live on http://localhost:${PORT}`));
}

module.exports = { startWebServer };