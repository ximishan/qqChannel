const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RATE_LIMIT_RE = /retCode=153|频率上限/;
const TOKEN_RE = /bot:v1_[A-Za-z0-9_-]+/g;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeError(value) {
  return String(value || '').replace(TOKEN_RE, '[REDACTED]').trim();
}

function parseLastJson(output) {
  const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (_) {}
  }
  return null;
}

class TencentChannelCli {
  constructor(options = {}) {
    this.userDataPath = options.userDataPath || '';
    this.cliPath = options.cliPath || '';
    this.executor = options.executor || null;
    this.guildCache = null;
    this.channelCache = new Map();
    this.serial = Promise.resolve();
  }

  candidatePaths() {
    const platformPackage = process.platform === 'win32'
      ? 'tencent-channel-cli-win32-x64'
      : `tencent-channel-cli-${process.platform}-${process.arch}`;
    const executable = process.platform === 'win32' ? 'tencent-channel-cli.exe' : 'tencent-channel-cli';
    const candidates = [this.cliPath, process.env.TENCENT_CHANNEL_CLI];

    try {
      const packageJson = require.resolve(`${platformPackage}/package.json`);
      candidates.push(path.join(path.dirname(packageJson), 'bin', executable));
    } catch (_) {}

    const projectRoot = path.resolve(__dirname, '..', '..');
    candidates.push(
      path.join(projectRoot, 'node_modules', platformPackage, 'bin', executable),
      path.join(projectRoot, 'node_modules', 'tencent-channel-cli', 'node_modules', platformPackage, 'bin', executable)
    );

    if (process.resourcesPath) {
      const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
      candidates.push(
        path.join(unpacked, platformPackage, 'bin', executable),
        path.join(unpacked, 'tencent-channel-cli', 'node_modules', platformPackage, 'bin', executable)
      );
    }

    if (process.env.APPDATA) {
      candidates.push(
        path.join(process.env.APPDATA, 'npm', 'node_modules', 'tencent-channel-cli', 'node_modules', platformPackage, 'bin', executable),
        path.join(process.env.APPDATA, 'npm', 'tencent-channel-cli.cmd')
      );
    }

    for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
      if (!directory) continue;
      candidates.push(path.join(directory, process.platform === 'win32' ? 'tencent-channel-cli.cmd' : 'tencent-channel-cli'));
      candidates.push(path.join(directory, executable));
    }

    return [...new Set(candidates.filter(Boolean).map(candidate => {
      const normalized = path.normalize(candidate);
      return normalized.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    }))];
  }

  findCli() {
    const candidate = this.candidatePaths().find(item => {
      try {
        return fs.statSync(item).isFile();
      } catch (_) {
        return false;
      }
    });
    if (!candidate) throw new Error('内置腾讯频道组件缺失，请重新安装完整版本。');
    this.cliPath = candidate;
    return candidate;
  }

  isolatedEnvironment() {
    const env = { ...process.env };
    if (!this.userDataPath) return env;

    const home = path.resolve(this.userDataPath);
    const appData = path.join(home, 'AppData', 'Roaming');
    const localAppData = path.join(home, 'AppData', 'Local');
    const xdgConfig = path.join(home, '.config');
    const xdgData = path.join(home, '.local', 'share');

    for (const directory of [home, appData, localAppData, xdgConfig, xdgData]) {
      fs.mkdirSync(directory, { recursive: true });
    }

    // tencent-channel-cli 的认证文件默认位于 ~/.qqcli。不同平台/运行时对“用户目录”
    // 的解析方式并不完全一致，因此不能只改 HOME/USERPROFILE；Windows 还可能通过
    // APPDATA/LOCALAPPDATA，部分库则读取 XDG_*。这里统一指向当前 QQ 账号自己的目录，
    // 确保 login status / login / poll-token / 发帖都不会读到其它账号的凭证。
    env.HOME = home;
    env.USERPROFILE = home;
    env.APPDATA = appData;
    env.LOCALAPPDATA = localAppData;
    env.XDG_CONFIG_HOME = xdgConfig;
    env.XDG_DATA_HOME = xdgData;
    env.QQCLI_HOME = home;
    env.QQCLI_CONFIG_DIR = path.join(home, '.qqcli');
    env.TENCENT_CHANNEL_CLI_HOME = home;

    // 避免宿主进程意外设置的 token 环境变量绕过账号目录隔离。
    delete env.QQCLI_TOKEN;
    delete env.QQ_CHANNEL_TOKEN;
    delete env.TENCENT_CHANNEL_TOKEN;

    return env;
  }

  execute(args, payload = null, timeoutMs = 180000) {
    if (this.executor) return this.executor(args, payload, timeoutMs);
    const cliPath = this.findCli();

    return new Promise((resolve, reject) => {
      let command = cliPath;
      let commandArgs = args;
      if (process.platform === 'win32' && /\.cmd$/i.test(cliPath)) {
        command = process.env.ComSpec || 'cmd.exe';
        const staticCommand = [`"${cliPath}"`, ...args].join(' ');
        commandArgs = ['/d', '/s', '/c', staticCommand];
      }

      const env = this.isolatedEnvironment();
      const cwd = this.userDataPath ? path.resolve(this.userDataPath) : undefined;

      const child = spawn(command, commandArgs, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        cwd
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`腾讯频道组件执行超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });

      if (payload == null) child.stdin.end();
      else child.stdin.end(JSON.stringify(payload));
    });
  }

  async run(args, payload = null, options = {}) {
    const work = async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const completed = await this.execute(args, payload, options.timeoutMs || 180000);
        const response = parseLastJson(completed.stdout);
        if (completed.code === 0 && response?.success) return response.data || {};

        const nested = response?.error;
        const detail = safeError(
          response?.message ||
          (typeof nested === 'object' ? nested?.message || nested?.hint : nested) ||
          completed.stderr ||
          completed.stdout
        );
        if (RATE_LIMIT_RE.test(detail) && attempt === 0) {
          await sleep(70000);
          continue;
        }
        throw new Error(detail || '腾讯频道组件执行失败。');
      }
      throw new Error('腾讯频道组件执行失败。');
    };

    const queued = this.serial.then(work, work);
    this.serial = queued.catch(() => {});
    return queued;
  }

  loginStatus() {
    return this.run(['login', 'status', '--json'], null, { timeoutMs: 30000 })
      .then(data => ({ loggedIn: Boolean(data.valid), name: data.valid ? 'QQ频道授权' : '', ...data }))
      .catch(error => ({ loggedIn: false, valid: false, message: safeError(error.message) }));
  }

  async beginLogin() {
    const status = await this.loginStatus();
    if (status.loggedIn) return { alreadyLoggedIn: true, ...status };
    const qrcodePath = path.join(this.userDataPath || os.homedir(), 'qq-channel-login.png');
    const data = await this.run(['login', '--json', '--qrcode-path', qrcodePath], null, { timeoutMs: 30000 });
    const returnedPath = String(data.qrcode_path || qrcodePath);
    let qrDataUrl = '';
    if (fs.existsSync(returnedPath)) {
      qrDataUrl = `data:image/png;base64,${fs.readFileSync(returnedPath).toString('base64')}`;
    }
    return {
      ...data,
      qrcodePath: returnedPath,
      qrDataUrl,
      verificationUri: String(data.verification_uri || data.verification_url || '')
    };
  }

  async pollLogin() {
    const data = await this.run(['login', 'poll-token', '--json'], null, { timeoutMs: 60000 });
    const status = await this.loginStatus();
    return { ...data, ...status };
  }

  async listGuilds(force = false) {
    if (this.guildCache && !force) return this.guildCache;
    const data = await this.run(['manage', 'get-my-join-guild-info', '--json'], {});
    const guilds = [];
    const seen = new Set();
    for (const group of ['created_guilds', 'managed_guilds', 'joined_guilds']) {
      for (const item of data[group] || []) {
        const guildId = String(item.guild_id || '').trim();
        if (!guildId || seen.has(guildId)) continue;
        seen.add(guildId);
        guilds.push({
          guildId,
          guildNumber: String(item.guild_number || '').trim(),
          name: String(item.name || '未命名频道'),
          role: String(item.role || '')
        });
      }
    }
    this.guildCache = guilds;
    return guilds;
  }

  async listChannels(guildId, force = false) {
    const key = String(guildId || '');
    if (this.channelCache.has(key) && !force) return this.channelCache.get(key);
    const data = await this.run(['manage', 'get-guild-channel-list', '--json'], { guild_id: key });
    const channels = (data.channels || []).map(item => ({
      channelId: String(item.channel_id || ''),
      name: String(item.channel_name || item.name || '未命名版块')
    })).filter(item => item.channelId);
    this.channelCache.set(key, channels);
    return channels;
  }

  normalizeLocalChannel(channel = {}) {
    const name = String(channel.channel_name ?? channel.name ?? '').trim();
    const url = String(channel.channel_url ?? channel.url ?? '').trim();
    const storedGuildNumber = String(channel.guild_number || '').trim();
    const guildNumber = storedGuildNumber || (url.match(/\/g\/(pd\d+)/i)?.[1] || '');
    return { name, url, guildNumber };
  }

  async resolveChannel(channel) {
    const local = this.normalizeLocalChannel(channel);
    let guilds = await this.listGuilds();
    const findGuild = () => guilds.find(item =>
      local.guildNumber && String(item.guildNumber || '').toLowerCase() === local.guildNumber.toLowerCase()
    ) || guilds.find(item => local.name && String(item.name || '').trim() === local.name);

    let guild = findGuild();
    if (!guild) {
      guilds = await this.listGuilds(true);
      guild = findGuild();
    }

    if (!guild) {
      const visible = guilds.slice(0, 12).map(item => `${item.name}(${item.guildNumber || '无频道号'})`).join('、');
      const error = new Error(
        `授权账号中未找到频道“${local.name || '未知频道'}”；` +
        `本地URL=${local.url || '未提供'}；解析频道号=${local.guildNumber || '未解析'}；` +
        `授权账号可见频道数=${guilds.length}` +
        `${visible ? `；可见频道=${visible}` : ''}。请确认频道 URL 和 QQ 授权账号`
      );
      error.code = 'CHANNEL_NOT_FOUND';
      error.retryable = false;
      throw error;
    }

    const channels = await this.listChannels(guild.guildId, true);
    const preferred = channels.find(item => item.name === '全部') || channels[0];
    if (!preferred) {
      const error = new Error(`频道“${local.name || guild.name}”没有可发布的帖子版块`);
      error.code = 'CHANNEL_BOARD_NOT_FOUND';
      error.retryable = false;
      throw error;
    }

    return {
      guildId: guild.guildId,
      guildNumber: guild.guildNumber || local.guildNumber,
      channelId: preferred.channelId,
      channelName: preferred.name
    };
  }

  publish({ guildId, channelId, content = '', mediaType = 'text', mediaPath = '' }) {
    const payload = {
      guild_id: String(guildId),
      channel_id: String(channelId),
      content: String(content || '').trim()
    };
    if (mediaType === 'image') payload.file_paths = [{ file_path: String(mediaPath) }];
    if (mediaType === 'video') payload.video_paths = [{ file_path: String(mediaPath) }];
    return this.run(['feed', 'publish-feed', '--json'], payload);
  }

  comment({ feedId, feedCreateTime, guildId, channelId, content }) {
    return this.run(['feed', 'do-comment', '--json'], {
      feed_id: String(feedId),
      feed_create_time: String(feedCreateTime),
      guild_id: String(guildId),
      channel_id: String(channelId),
      content: String(content || '').trim()
    });
  }
}

module.exports = { TencentChannelCli, parseLastJson, safeError };
