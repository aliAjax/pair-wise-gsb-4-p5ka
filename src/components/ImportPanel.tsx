// 侧栏：分发方式选择、清单导入（文本 / 文件）、手动添加、数据操作。
import { useRef, useState } from 'react';
import { Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { DISTRIBUTIONS, type Distribution } from '../lib/policy';

interface Props {
  distribution: Distribution;
  onDistribution: (d: Distribution) => void;
  onImport: (text: string, reason: string) => void;
  onResetSample: () => void;
  onClearAll: () => void;
}

export default function ImportPanel({ distribution, onDistribution, onImport, onResetSample, onClearAll }: Props) {
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualExpr, setManualExpr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const submitImport = () => {
    if (!text.trim()) return;
    onImport(text, reason.trim());
    setText('');
    setReason('');
  };

  const submitManual = () => {
    if (!manualName.trim() || !manualExpr.trim()) return;
    onImport(`${manualName.trim()} ${manualExpr.trim()}`, reason.trim() || '手动添加');
    setManualName('');
    setManualExpr('');
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <>
      <div className="side-section">
        <div className="side-label">项目分发方式</div>
        <div className="dist-list">
          {DISTRIBUTIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`dist ${d.id === distribution ? 'active' : ''}`}
              onClick={() => onDistribution(d.id)}
            >
              <strong>{d.label}</strong>
              <span>{d.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="side-section">
        <div className="side-label">导入依赖清单</div>
        <textarea
          className="manifest-input"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'每行一个依赖：\nreact@18.3.1 MIT\nleft-pad@1.3.0 (MIT OR Apache-2.0)\n\n也支持粘贴 package.json / CSV / JSON 数组'}
        />
        <input
          className="reason-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="导入原因（记入版本链，可选）"
        />
        <button type="button" className="primary block" onClick={submitImport} disabled={!text.trim()}>
          解析并导入
        </button>
        <label className="file-drop">
          <Upload size={14} /> 选择 package.json / 清单文件
          <input ref={fileRef} type="file" accept=".json,.txt,.csv,.lock" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <p className="hint">未知标识、冲突组合或缺证据的附条件义务会使整批停在待复核；已裁决依赖再次导入只会生成带原因的新版本。</p>
      </div>

      <div className="side-section">
        <div className="side-label">手动添加</div>
        <div className="manual-row">
          <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="依赖名" />
          <input value={manualExpr} onChange={(e) => setManualExpr(e.target.value)} placeholder="SPDX 表达式，如 Apache-2.0" />
        </div>
        <button type="button" className="secondary block" onClick={submitManual} disabled={!manualName.trim() || !manualExpr.trim()}>
          <Plus size={14} /> 添加依赖
        </button>
      </div>

      <div className="side-section side-foot">
        <button type="button" className="ghost sm" onClick={onResetSample}>
          <RotateCcw size={13} /> 载入示例
        </button>
        <button type="button" className="ghost sm danger" onClick={onClearAll}>
          <Trash2 size={13} /> 清空工作区
        </button>
      </div>
    </>
  );
}
