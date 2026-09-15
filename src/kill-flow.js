const { assessStopRisk, verifyExpectedProcess } = require('./process-safety');

const COMMAND_LINE_PREVIEW_LENGTH = 300;
const CHILD_NAME_PREVIEW_COUNT = 5;

const BUTTON = { cancel: 0, graceful: 1, force: 2 };

function truncate(text, maxLength) {
  const value = String(text || '');
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function describeChildren(children) {
  const names = children.slice(0, CHILD_NAME_PREVIEW_COUNT).map((p) => `${p.Name} (${p.ProcessId})`);
  const rest = children.length - names.length;
  return rest > 0 ? `${names.join(', ')} ほか${rest}件` : names.join(', ');
}

/**
 * プロセス停止の対話フロー。
 * 停止直前の再検証 → 危険度判定 → 確認ダイアログ → 通常停止/強制停止 → 終了確認 の順に進む。
 *
 * @param {object} deps
 * @param {ReturnType<import('./port-killer').createProcessKiller>} deps.killer
 * @param {(options: object) => Promise<{ response: number, checkboxChecked: boolean }>} deps.showMessageBox
 * @param {number} deps.selfPid
 * @param {string} deps.currentUser
 */
function createKillFlow({ killer, showMessageBox, selfPid, currentUser }) {
  async function showBlocked(title, message, reasons) {
    await showMessageBox({
      type: 'error',
      buttons: ['閉じる'],
      defaultId: 0,
      title,
      message,
      detail: reasons.join('\n'),
    });
  }

  async function run(request) {
    const { pid, port, protocol, processName } = request;

    let info;
    try {
      info = await killer.inspectProcess(pid);
    } catch (err) {
      return { success: false, error: `プロセス情報を取得できませんでした: ${err.message}` };
    }

    const verification = verifyExpectedProcess({
      expected: { processName, port, protocol },
      target: info.target,
      tcpPorts: info.tcpPorts,
      udpPorts: info.udpPorts,
    });
    if (!verification.ok) {
      await showBlocked('停止を中止しました', '表示時点からプロセスの状態が変わっています', [
        verification.reason,
        '一覧を更新してから、もう一度お試しください。',
      ]);
      return { success: false, stale: true, error: verification.reason };
    }

    const riskInput = {
      pid,
      target: info.target,
      owner: info.owner,
      currentUser,
      processes: info.processes,
      selfPid,
    };
    const risk = assessStopRisk(riskInput);
    if (risk.level === 'blocked') {
      await showBlocked('停止できません', `${info.target.Name}（PID ${pid}）は停止できません`, risk.reasons);
      return { success: false, blocked: true, error: risk.reasons.join(' / ') };
    }

    const children = risk.childProcesses;
    const detail = [
      port ? `ポート: ${port}/${protocol}` : null,
      `実行ユーザー: ${info.owner || '取得できませんでした'}`,
      info.target.CommandLine ? `コマンドライン: ${truncate(info.target.CommandLine, COMMAND_LINE_PREVIEW_LENGTH)}` : null,
      children.length > 0 ? `子プロセス: ${describeChildren(children)}` : null,
      risk.reasons.length > 0 ? `\n⚠ 注意\n${risk.reasons.map((r) => `・${r}`).join('\n')}` : null,
      '\n通常停止: アプリに終了を要求します（node / python などのコンソールアプリは応答しないため、強制停止を案内します）',
      '強制停止: 即座に終了させます。保存されていないデータは失われます',
    ].filter(Boolean).join('\n');

    const choice = await showMessageBox({
      type: risk.level === 'danger' ? 'warning' : 'question',
      buttons: ['キャンセル', '通常停止', '強制停止'],
      defaultId: risk.level === 'danger' ? BUTTON.cancel : BUTTON.graceful,
      cancelId: BUTTON.cancel,
      noLink: true,
      title: 'プロセスの停止',
      message: `${info.target.Name}（PID ${pid}）を停止しますか？`,
      detail,
      ...(children.length > 0
        ? { checkboxLabel: `子プロセス（${children.length}件）もまとめて停止する`, checkboxChecked: true }
        : {}),
    });
    if (choice.response === BUTTON.cancel) {
      return { success: false, cancelled: true };
    }

    const tree = children.length > 0 && Boolean(choice.checkboxChecked);
    const effectiveRisk = tree ? assessStopRisk({ ...riskInput, includeTree: true }) : risk;
    if (effectiveRisk.level === 'blocked') {
      await showBlocked('停止できません', '子プロセスを含めた停止はできません', effectiveRisk.reasons);
      return { success: false, blocked: true, error: effectiveRisk.reasons.join(' / ') };
    }

    if (effectiveRisk.level === 'danger') {
      const confirm = await showMessageBox({
        type: 'warning',
        buttons: ['キャンセル', '停止する'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: '確認',
        message: '本当に停止しますか？',
        detail: effectiveRisk.reasons.map((r) => `・${r}`).join('\n'),
      });
      if (confirm.response !== 1) {
        return { success: false, cancelled: true };
      }
    }

    const base = { pid, processName: info.target.Name, tree };

    if (choice.response === BUTTON.graceful) {
      const graceful = await killer.stopProcess(pid, { force: false, tree });
      if (graceful.exitCode === 0 && await killer.waitForExit(pid, { timeoutMs: 5000 })) {
        return { success: true, method: 'graceful', ...base };
      }

      const fallback = await showMessageBox({
        type: 'warning',
        buttons: ['キャンセル', '強制停止'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: '通常停止できませんでした',
        message: `${info.target.Name}（PID ${pid}）は通常停止では終了しませんでした。強制停止しますか？`,
        detail: graceful.message || '終了要求に応答しませんでした',
      });
      if (fallback.response !== 1) {
        return { success: false, cancelled: true, gracefulFailed: true, ...base };
      }
    }

    const forced = await killer.stopProcess(pid, { force: true, tree });
    if (await killer.waitForExit(pid, { timeoutMs: 3000 })) {
      return { success: true, method: 'force', ...base };
    }
    return {
      success: false,
      error: forced.message || 'プロセスを停止できませんでした（管理者権限が必要な可能性があります）',
      ...base,
    };
  }

  return { run };
}

module.exports = { createKillFlow, BUTTON };
