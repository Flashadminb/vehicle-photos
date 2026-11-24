import { useState } from 'react';
import { CaptureView } from '../field/CaptureView';
import { makeTranslator, stepLabel } from '../../shared/i18n';
import type { Language, WorkflowStep } from '../../shared/types';
import type { Slot } from '../field/engine';

/** Live preview of the field interface using the draft (unsaved) configuration. */
export function FieldPreview({
  steps,
  overrides,
  languages,
  fallbackLanguage,
  initialLang,
}: {
  steps: WorkflowStep[];
  overrides: Record<string, Record<string, string>>;
  languages: Language[];
  fallbackLanguage: string;
  initialLang: string;
}) {
  const [lang, setLang] = useState(initialLang);
  const [stepIndex, setStepIndex] = useState(0);
  const t = makeTranslator(overrides, lang, fallbackLanguage);
  const viewSteps = steps.map((s) => ({ id: s.id, label: stepLabel(s.labels, lang, fallbackLanguage), required: s.required, allowUpload: s.allowUpload }));
  const slots: Record<string, Slot> = {};
  steps.forEach((s, i) => {
    slots[s.id] = { status: i < Math.min(stepIndex, steps.length) ? (i === 0 ? 'uploaded' : 'uploading') : 'empty' };
  });
  return (
    <div className="preview">
      <div className="preview-controls">
        <label className="field-inline small">
          ภาษาตัวอย่าง
          <select className="input input-sm" value={lang} onChange={(e) => setLang(e.target.value)}>
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline small">
          หน้าจอ
          <select className="input input-sm" value={stepIndex} onChange={(e) => setStepIndex(Number(e.target.value))}>
            {steps.map((s, i) => (
              <option key={s.id} value={i}>
                ขั้นตอนที่ {i + 1}
              </option>
            ))}
            <option value={steps.length}>ตรวจสอบ / เสร็จสิ้น</option>
          </select>
        </label>
      </div>
      <div className="phone" aria-label="ตัวอย่างแอปภาคสนาม">
        <CaptureView
          preview
          t={t}
          appName={t('app_name')}
          steps={viewSteps}
          stepIndex={Math.min(stepIndex, steps.length)}
          slots={slots}
          online
          publicId="PF-000123"
          doneEnabled={false}
          doneBlocker="uploading"
          finalize={{ status: 'idle' }}
          flash={null}
          onTake={() => {}}
          onUpload={() => {}}
          onSkip={() => {}}
          onSelectStep={setStepIndex}
          onRetry={() => {}}
          onDone={() => {}}
        />
      </div>
    </div>
  );
}
