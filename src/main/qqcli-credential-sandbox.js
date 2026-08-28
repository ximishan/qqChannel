const fs = require('fs');
const os = require('os');
const path = require('path');
const { TencentChannelCli } = require('./tencent-channel-cli');

let installed = false;
let globalQueue = Promise.resolve();

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch (_) {
    return false;
  }
}

function remove(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {}
}

function copyDir(source, target) {
  if (!exists(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function installCredentialSandbox() {
  if (installed) return;
  installed = true;

  const originalExecute = TencentChannelCli.prototype.execute;

  TencentChannelCli.prototype.execute = function executeWithCredentialSandbox(args, payload = null, timeoutMs = 180000) {
    // 测试注入的 executor 不需要碰真实登录目录。
    if (this.executor || !this.userDataPath) {
      return originalExecute.call(this, args, payload, timeoutMs);
    }

    const work = async () => {
      const accountHome = path.resolve(this.userDataPath);
      const accountQqcli = path.join(accountHome, '.qqcli');
      const realHome = os.homedir();
      const realQqcli = path.join(realHome, '.qqcli');
      const backupQqcli = path.join(realHome, '.qqcli.qqchannel-publisher-backup');

      if (samePath(accountQqcli, realQqcli)) {
        return originalExecute.call(this, args, payload, timeoutMs);
      }

      fs.mkdirSync(accountHome, { recursive: true });

      // 如果上一次程序异常退出时留下备份，先恢复用户原来的全局 CLI 登录目录。
      if (exists(backupQqcli)) {
        remove(realQqcli);
        fs.renameSync(backupQqcli, realQqcli);
      }

      const hadOriginalGlobal = exists(realQqcli);
      if (hadOriginalGlobal) {
        fs.renameSync(realQqcli, backupQqcli);
      }

      // 只把当前 QQ 账号自己的凭证临时放到 CLI 实际会读取的 ~/.qqcli。
      // 当前账号尚未登录时，必须保证这里是空的，绝不能继承其它账号的 token。
      remove(realQqcli);
      if (exists(accountQqcli)) copyDir(accountQqcli, realQqcli);

      try {
        return await originalExecute.call(this, args, payload, timeoutMs);
      } finally {
        // login/poll-token 可能更新 token：把本次执行后的状态保存回当前账号目录。
        remove(accountQqcli);
        if (exists(realQqcli)) copyDir(realQqcli, accountQqcli);

        // 恢复用户原先的全局 tencent-channel-cli 状态，避免影响软件外部的 CLI。
        remove(realQqcli);
        if (hadOriginalGlobal && exists(backupQqcli)) {
          fs.renameSync(backupQqcli, realQqcli);
        } else {
          remove(backupQqcli);
        }
      }
    };

    // CLI 在 Windows 上可能无视 HOME/USERPROFILE，直接访问真实 ~/.qqcli。
    // 因此所有账号的 CLI 调用必须全局串行，防止两个账号同时交换凭证造成串号。
    const queued = globalQueue.then(work, work);
    globalQueue = queued.catch(() => {});
    return queued;
  };
}

installCredentialSandbox();

module.exports = { installCredentialSandbox };
