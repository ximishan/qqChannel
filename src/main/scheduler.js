class TaskScheduler {
  constructor(db, browserManager) {
    this.db = db;
    this.browserManager = browserManager;
    this.states = new Map();
  }

  ensureState(instanceId) {
    const id = Number(instanceId);
    if (!this.states.has(id)) {
      this.states.set(id, {
        instanceId: id,
        status: 'idle',
        currentTaskId: null,
        nextRunAt: null,
        lastError: '',
        stopRequested: false,
        workerPromise: null
      });
    }
    return this.states.get(id);
  }

  getState(instanceId) {
    const state = this.ensureState(instanceId);
    return {
      instanceId: state.instanceId,
      status: state.status,
      currentTaskId: state.currentTaskId,
      nextRunAt: state.nextRunAt,
      lastError: state.lastError,
      pendingCount: this.db.countPendingTasks(state.instanceId)
    };
  }

  async start(instanceId) {
    const state = this.ensureState(instanceId);

    if (state.status === 'running' || state.status === 'waiting') {
      return this.getState(instanceId);
    }

    if (state.status === 'paused' && state.workerPromise) {
      state.status = 'running';
      state.lastError = '';
      this.db.log('info', `实例 #${instanceId} 发布队列继续`);
      return this.getState(instanceId);
    }

    state.status = 'running';
    state.stopRequested = false;
    state.lastError = '';
    state.workerPromise = this.runLoop(state).finally(() => {
      state.workerPromise = null;
      if (state.status !== 'stopped' && state.status !== 'error') state.status = 'idle';
      state.currentTaskId = null;
      state.nextRunAt = null;
    });

    this.db.log('info', `实例 #${instanceId} 发布队列启动`);
    return this.getState(instanceId);
  }

  pause(instanceId) {
    const state = this.ensureState(instanceId);
    if (['running', 'waiting'].includes(state.status)) {
      state.status = 'paused';
      this.db.log('info', `实例 #${instanceId} 发布队列暂停（当前正在发布的单条任务会先执行完）`);
    }
    return this.getState(instanceId);
  }

  resume(instanceId) {
    const state = this.ensureState(instanceId);
    if (state.status === 'paused') {
      state.status = 'running';
      this.db.log('info', `实例 #${instanceId} 发布队列继续`);
    }
    return this.getState(instanceId);
  }

  stop(instanceId) {
    const state = this.ensureState(instanceId);
    state.stopRequested = true;
    state.status = 'stopped';
    state.nextRunAt = null;
    this.db.log('info', `实例 #${instanceId} 发布队列停止（当前正在发布的单条任务会先执行完）`);
    return this.getState(instanceId);
  }

  randomIntervalMs() {
    let min = Number(this.db.getSetting('interval_min_seconds', '180'));
    let max = Number(this.db.getSetting('interval_max_seconds', '480'));
    if (!Number.isFinite(min)) min = 180;
    if (!Number.isFinite(max)) max = 480;
    min = Math.max(0, Math.floor(min));
    max = Math.max(0, Math.floor(max));
    if (max < min) [min, max] = [max, min];
    const seconds = min === max ? min : Math.floor(Math.random() * (max - min + 1)) + min;
    return seconds * 1000;
  }

  async sleepInterruptible(state, ms) {
    const end = Date.now() + ms;
    state.nextRunAt = end;

    while (Date.now() < end) {
      if (state.stopRequested || state.status === 'stopped') return false;

      while (state.status === 'paused') {
        if (state.stopRequested || state.status === 'stopped') return false;
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      state.status = 'waiting';
      await new Promise(resolve => setTimeout(resolve, Math.min(500, end - Date.now())));
    }

    state.nextRunAt = null;
    state.status = 'running';
    return true;
  }

  async waitWhilePaused(state) {
    while (state.status === 'paused') {
      if (state.stopRequested || state.status === 'stopped') return false;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return !(state.stopRequested || state.status === 'stopped');
  }

  async runLoop(state) {
    try {
      while (!state.stopRequested) {
        if (!(await this.waitWhilePaused(state))) break;
        state.status = 'running';

        const task = this.db.getNextPendingTask(state.instanceId);
        if (!task) {
          this.db.log('info', `实例 #${state.instanceId} 没有待发布任务，队列结束`);
          state.status = 'idle';
          return;
        }

        state.currentTaskId = task.id;
        state.lastError = '';

        try {
          await this.browserManager.publishTask(task);
        } catch (err) {
          state.lastError = String(err?.message || err);

          // 登录失效时停止继续消费队列，避免后续任务全部失败。
          if (/未登录|登录状态已失效|登录已失效/.test(state.lastError)) {
            state.status = 'paused';
            this.db.log('warn', `实例 #${state.instanceId} 因登录状态异常自动暂停：${state.lastError}`);
            while (state.status === 'paused' && !state.stopRequested) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            if (state.stopRequested) break;
          }
        }

        state.currentTaskId = null;
        if (state.stopRequested) break;

        const pending = this.db.countPendingTasks(state.instanceId);
        if (pending <= 0) {
          state.status = 'idle';
          this.db.log('info', `实例 #${state.instanceId} 待发布任务已全部处理完毕`);
          return;
        }

        const waitMs = this.randomIntervalMs();
        this.db.log('info', `实例 #${state.instanceId} 下一条任务等待 ${Math.round(waitMs / 1000)} 秒`);
        const ok = await this.sleepInterruptible(state, waitMs);
        if (!ok) break;
      }
    } catch (err) {
      state.lastError = String(err?.message || err);
      state.status = 'error';
      this.db.log('error', `实例 #${state.instanceId} 发布队列异常：${state.lastError}`);
    }
  }
}

module.exports = TaskScheduler;
