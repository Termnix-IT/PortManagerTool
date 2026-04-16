const { execFile } = require('child_process');

function killProcess(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/F'], (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: stderr || err.message });
      } else {
        resolve({ success: true, message: stdout.trim() });
      }
    });
  });
}

module.exports = { killProcess };
