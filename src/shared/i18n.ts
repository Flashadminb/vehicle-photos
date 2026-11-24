/**
 * Built-in field-app interface strings. Administrators override any of these per
 * language from the dashboard (stored in the `translations` table) and can add
 * new languages; missing keys fall back to the configured fallback language,
 * then to these built-ins, then to the key itself.
 */
export const TRANSLATION_KEYS = [
  'app_name',
  'login_title',
  'username',
  'password',
  'sign_in',
  'sign_out',
  'take_photo',
  'upload_photo',
  'step_progress',
  'optional',
  'required',
  'skip_step',
  'retake',
  'replace_photo',
  'review_title',
  'review_hint',
  'done',
  'done_hint_missing',
  'done_hint_uploading',
  'finalizing',
  'set_saved',
  'finalize_failed',
  'retry',
  'status_queued',
  'status_uploading',
  'status_uploaded',
  'status_failed',
  'status_skipped',
  'status_missing',
  'offline_banner',
  'language',
  'locked_title',
  'enter_pin',
  'unlock',
  'wrong_pin',
  'error_generic',
  'upload_not_allowed',
  'change_password_title',
  'new_password',
  'save',
] as const;

export type TranslationKey = (typeof TRANSLATION_KEYS)[number];

export const BUILTIN_TRANSLATIONS: Record<string, Record<TranslationKey, string>> = {
  en: {
    app_name: 'Vehicle Photos',
    login_title: 'Sign in to start capturing',
    username: 'Username',
    password: 'Password',
    sign_in: 'Sign in',
    sign_out: 'Sign out',
    take_photo: 'Take photo',
    upload_photo: 'Upload photo',
    step_progress: 'Step {current} of {total}',
    optional: 'Optional',
    required: 'Required',
    skip_step: 'Skip this step',
    retake: 'Retake',
    replace_photo: 'Replace',
    review_title: 'Check the set',
    review_hint: 'Tap a step to retake it before saving.',
    done: 'DONE',
    done_hint_missing: 'Required photos are missing.',
    done_hint_uploading: 'Waiting for uploads to finish…',
    finalizing: 'Saving set…',
    set_saved: 'Set saved — ready for the next vehicle.',
    finalize_failed: 'Could not save the set. Your photos are kept. Try again.',
    retry: 'Retry',
    status_queued: 'Waiting',
    status_uploading: 'Uploading',
    status_uploaded: 'Saved',
    status_failed: 'Failed',
    status_skipped: 'Skipped',
    status_missing: 'Missing',
    offline_banner: 'Offline — photos are kept on this device and will upload when the connection returns.',
    language: 'Language',
    locked_title: 'App locked',
    enter_pin: 'Enter your PIN',
    unlock: 'Unlock',
    wrong_pin: 'Incorrect PIN',
    error_generic: 'Something went wrong.',
    upload_not_allowed: 'Uploading a file is not allowed for this step.',
    change_password_title: 'Set a new password',
    new_password: 'New password (at least 8 characters)',
    save: 'Save',
  },
  th: {
    app_name: 'ถ่ายรูปรถ',
    login_title: 'เข้าสู่ระบบเพื่อเริ่มถ่ายรูป',
    username: 'ชื่อผู้ใช้',
    password: 'รหัสผ่าน',
    sign_in: 'เข้าสู่ระบบ',
    sign_out: 'ออกจากระบบ',
    take_photo: 'ถ่ายรูป',
    upload_photo: 'อัปโหลดรูป',
    step_progress: 'ขั้นตอนที่ {current} จาก {total}',
    optional: 'ไม่บังคับ',
    required: 'บังคับ',
    skip_step: 'ข้ามขั้นตอนนี้',
    retake: 'ถ่ายใหม่',
    replace_photo: 'เปลี่ยนรูป',
    review_title: 'ตรวจสอบชุดรูป',
    review_hint: 'แตะขั้นตอนเพื่อถ่ายใหม่ก่อนบันทึก',
    done: 'เสร็จสิ้น',
    done_hint_missing: 'ยังขาดรูปที่บังคับ',
    done_hint_uploading: 'กำลังรออัปโหลดให้เสร็จ…',
    finalizing: 'กำลังบันทึกชุดรูป…',
    set_saved: 'บันทึกชุดแล้ว — พร้อมถ่ายคันถัดไป',
    finalize_failed: 'บันทึกชุดไม่สำเร็จ รูปยังอยู่ครบ กรุณาลองใหม่',
    retry: 'ลองใหม่',
    status_queued: 'รอคิว',
    status_uploading: 'กำลังอัปโหลด',
    status_uploaded: 'บันทึกแล้ว',
    status_failed: 'ล้มเหลว',
    status_skipped: 'ข้ามแล้ว',
    status_missing: 'ยังไม่มีรูป',
    offline_banner: 'ออฟไลน์ — รูปถูกเก็บในเครื่องและจะอัปโหลดเมื่อกลับมาออนไลน์',
    language: 'ภาษา',
    locked_title: 'แอปถูกล็อก',
    enter_pin: 'ใส่ PIN',
    unlock: 'ปลดล็อก',
    wrong_pin: 'PIN ไม่ถูกต้อง',
    error_generic: 'เกิดข้อผิดพลาด',
    upload_not_allowed: 'ขั้นตอนนี้ไม่อนุญาตให้อัปโหลดไฟล์',
    change_password_title: 'ตั้งรหัสผ่านใหม่',
    new_password: 'รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)',
    save: 'บันทึก',
  },
};

export type TranslationTable = Record<string, Record<string, string>>;

/** Build a translator with language → fallback language → English built-in → key. */
export function makeTranslator(
  table: TranslationTable,
  lang: string,
  fallbackLang: string,
): (key: string, vars?: Record<string, string | number>) => string {
  return (key, vars) => {
    const raw =
      table[lang]?.[key] ??
      BUILTIN_TRANSLATIONS[lang]?.[key as TranslationKey] ??
      table[fallbackLang]?.[key] ??
      BUILTIN_TRANSLATIONS[fallbackLang]?.[key as TranslationKey] ??
      BUILTIN_TRANSLATIONS.en[key as TranslationKey] ??
      key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  };
}

/** Step label with the same fallback chain. */
export function stepLabel(labels: Record<string, string>, lang: string, fallbackLang: string): string {
  return labels[lang] || labels[fallbackLang] || labels.en || Object.values(labels)[0] || '?';
}
