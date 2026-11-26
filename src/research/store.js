const fs = require('fs');
const path = require('path');

function createStore(dir) {
  const root = dir || path.join(__dirname, '..', '..', 'data', 'research');
  function file(name) {
    return path.join(root, name);
  }
  function ensure() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  function append(name, row) {
    ensure();
    fs.appendFileSync(file(name), JSON.stringify(row) + '\n', 'utf8');
  }
  function readJsonl(name) {
    const target = file(name);
    if (!fs.existsSync(target)) return [];
    return fs.readFileSync(target, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch (err) { return null; }
      })
      .filter(Boolean);
  }
  function readState() {
    const target = file('state.json');
    if (!fs.existsSync(target)) return { mints: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return { mints: {} };
      if (!parsed.mints || typeof parsed.mints !== 'object') parsed.mints = {};
      return parsed;
    } catch (err) {
      return { mints: {} };
    }
  }
  function writeState(state) {
    ensure();
    const tmp = file(`state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file('state.json'));
  }
  function writeJson(name, value) {
    ensure();
    fs.writeFileSync(file(name), JSON.stringify(value, null, 2), 'utf8');
  }
  return { root, append, readJsonl, readState, writeState, writeJson, file };
}

module.exports = { createStore };
