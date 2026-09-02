module.exports = function installOwnedChannelListSupport(DB) {
  DB.prototype.listChannels = function listConfirmedOwnedChannels(instanceId) {
    return this.db.prepare(`
      SELECT * FROM channels
      WHERE instance_id=?
        AND enabled=1
        AND COALESCE(ownership_status,'unknown')='owned'
      ORDER BY id ASC
    `).all(Number(instanceId));
  };
};