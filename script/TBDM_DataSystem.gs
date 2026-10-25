/**
 * ============================================================================
 *  TB-DM COHORT, LAHORE GENERAL HOSPITAL: GOOGLE SHEETS DATA SYSTEM v1.1
 *  16 October 2026 (v1.1 adds the phone app API). One file: paste into the spreadsheet's Apps Script editor.
 * ============================================================================
 *  Replaces the paper Data Collection Register for the five companion studies.
 *  Consent forms, the Core Per-Patient File (with the MRN), the paper event
 *  forms and the linking log STAY ON PAPER. No name, CNIC, telephone number,
 *  address or MRN is ever entered in any Google file.
 *
 *  What it builds, in one folder in the principal investigator's Google Drive:
 *    TBDM_Data            the data entry workbook (the spreadsheet holding this script)
 *    TBDM_CXR_Reader1/2   one file per radiograph reader, so each reader stays blind
 *    TBDM_AuditLog        every change with old and new value; only the PI can open it
 *    TBDM_Exports         weekly CSV snapshots with SPSS import syntax; PI only
 *
 *  Install (full steps in the Data Collection Manual, Appendix A):
 *    1. Create a blank Google Sheet and name it TBDM_Data.
 *    2. Extensions > Apps Script. Replace the sample code with this file. Save.
 *    3. Reload the spreadsheet. Menu: TB-DM Study > PI: set up or repair.
 *    4. Approve the permissions, then choose the same menu item again.
 *  Running setup again is safe: it repairs missing parts and never deletes data.
 *  If a tab's headers differ from this script, setup stops without changing anything. Use
 *  "PI: upgrade the workbook in place" instead: it backs everything up, moves the data into the new
 *  columns and leaves the phones, their invitations and the web app address untouched.
 *  To change the script later WITHOUT re-inviting anyone: paste the new code into the SAME project,
 *  then Deploy > Manage deployments > pencil > Version: New version > Deploy. Never "New deployment".
 *  Never use File > Make a copy on the real workbook: practise in a separate system built
 *  the same way, so that practice entries can never reach the real audit log or reader files.
 * ============================================================================
 */

const CFG = {
  VERSION: '1.2',
  SCHEMA_VER: 3,                      // raised whenever a data tab gains, loses or reorders a column; phones compare it before sending
  ID_PREFIX: 'TBDM-',
  ID_MAX: 999,                     // three digits after the prefix; the format cannot go higher without changing the id rules
  BLOCK_SIZE: 10,                  // study numbers handed to one phone at a time, so two phones that are offline together never offer the same number
  BLOCK_GRACE_DAYS: 14,            // numbers still unused inside a block handed to a phone in the last 14 days are not reported as skipped
  BLOCK_LOW: 3,                    // a phone asks for its next block when this many or fewer numbers are left in its own blocks
  EARLIEST: '2026-10-01',          // no study date can be earlier than this
  PULSE_PRIMARY: 90,               // TBscore pulse threshold (Rudolf 2014)
  PULSE_SENSITIVITY: 100,          // sensitivity analysis threshold
  // [target day, window opens, window closes], days from the date ATT started
  WINDOWS: { V1: [0, 0, 7], V2: [28, 21, 35], V3: [56, 49, 70], V4: [84, 77, 98], V5: [168, 154, 182] },
  UPCOMING_DAYS: 14,
  TAG: 'TBDM:',                    // prefix on every protection this script creates
  TZ: 'Asia/Karachi',
  LOCALE: 'en_GB',
  EXPORTS: 'TBDM_Exports (PI only)'
};

// ---------------------------------------------------------------- code lists
const YN = [['Y', 'yes'], ['N', 'no']];
const CONSENT = [['A', 'agreed'], ['D', 'declined']];          // what the consent form says, worded as an answer rather than as a double negative
const PRESENT = [['P', 'present'], ['A', 'absent']];
const AUSC = [['P', 'abnormal'], ['A', 'normal']];
const SEX = [['M', 'male'], ['F', 'female']];
const ITEM = [['0', 'not at all'], ['1', 'several days'], ['2', 'more than half the days'], ['3', 'nearly every day']];
const SMEAR = [['N', 'negative'], ['S', 'scanty'], ['1', '1+'], ['2', '2+'], ['3', '3+']];
const LIPID_UNIT = [['M', 'mg/dL'], ['L', 'mmol/L']];
const SEROLOGY = [['N', 'negative'], ['P', 'positive'], ['X', 'not done']];
const EXCL = [['1', 'previously treated'], ['2', 'known HIV'], ['3', 'steroid or immunosuppressant'], ['4', 'haematological malignancy'],
  ['5', 'chronic liver or kidney disease'], ['6', 'pregnant'], ['7', 'acute bacterial infection'], ['8', 'smear-negative or extrapulmonary'],
  ['9', 'age under 18'], ['10', 'not treatment-naive'], ['11', 'cannot consent']];
const DM_DRUGS = (function () {          // 0, or letters in the order M S I O with no repeats
  const L = ['M', 'S', 'I', 'O'], out = ['0'];
  for (let m = 1; m < 16; m++) { let s = ''; for (let i = 0; i < 4; i++) if (m & (1 << i)) s += L[i]; out.push(s); }
  return out;
})();
const HEP = ['hep_nausea', 'hep_vomiting', 'hep_anorexia', 'hep_abdo_pain', 'hep_dark_urine', 'hep_jaundice', 'hep_fatigue'];
const TB_SYMPTOMS = ['tb_cough', 'tb_haemoptysis', 'tb_dyspnoea', 'tb_chest_pain', 'tb_night_sweats'];
// RUCAM, updated version (Danan and Teschke 2016). Two scales chosen by the injury pattern in e2_rucam_type:
// H hepatocellular (R 5 or more); C cholestatic or mixed (R below 5). R = (ALT / ALT ULN) / (ALP / ALP ULN).
// Each item: key, label, [code, text, points, scale]; an option with a scale counts only for that scale.
// An item with a 4th element 'C' applies to the cholestatic or mixed scale only.
const RUCAM_TYPES = [['H', 'hepatocellular (R 5 or more)'], ['C', 'cholestatic or mixed (R below 5)']];
const RUCAM = [
  ['e2_rucam_onset', 'E2: RUCAM 1. Time to onset of the reaction', [
    ['A', '5 to 90 days after starting ATT (after re-exposure: 1 to 15 days if hepatocellular, 1 to 90 days if cholestatic or mixed)', 2],
    ['B', 'less than 5 or more than 90 days after starting ATT (after re-exposure: more than 15 days if hepatocellular, more than 90 days if cholestatic or mixed)', 1],
    ['C', 'began after ATT was stopped: within 15 days if hepatocellular, within 30 days if cholestatic or mixed', 1]]],
  ['e2_rucam_course', 'E2: RUCAM 2. Course after stopping the drug, against the peak: ALT if hepatocellular, ALP if cholestatic or mixed', [
    ['A', 'hepatocellular: ALT fell by 50% or more within 8 days', 3, 'H'], ['B', 'hepatocellular: ALT fell by 50% or more within 30 days', 2, 'H'],
    ['C', 'hepatocellular: no information, or the drug was continued', 0, 'H'], ['D', 'hepatocellular: ALT fell by 50% or more only after day 30', 0, 'H'],
    ['E', 'hepatocellular: ALT fell by less than 50% after day 30, or rose again', -2, 'H'],
    ['F', 'cholestatic or mixed: ALP fell by 50% or more within 180 days', 2, 'C'], ['G', 'cholestatic or mixed: ALP fell by less than 50% within 180 days', 1, 'C'],
    ['H', 'cholestatic or mixed: no information, persisted, rose, or the drug was continued', 0, 'C']]],
  ['e2_rucam_alcohol', 'E2: RUCAM 3a. Alcohol: more than 2 drinks a day (women) or 3 (men)', [['Y', 'yes', 1], ['N', 'no', 0]]],
  ['e2_rucam_age55', 'E2: RUCAM 3b. Age 55 years or more', [['Y', 'yes', 1], ['N', 'no', 0]]],
  ['e2_rucam_preg', 'E2: RUCAM 3c. Pregnancy (cholestatic or mixed scale only)', [['Y', 'yes', 1], ['N', 'no', 0]], 'C'],
  ['e2_rucam_conmed', 'E2: RUCAM 4. Other drugs or herbs taken (not the ATT regimen, which is the suspect)', [['A', 'none, or no information', 0], ['B', 'taken, but the timing is incompatible', 0], ['C', 'taken, timing compatible or suggestive', -1], ['D', 'known liver-toxic drug, timing compatible or suggestive', -2], ['E', 'evidence of its role (positive re-exposure or a validated test)', -3]]],
  ['e2_rucam_altcause', 'E2: RUCAM 5. Search for other causes', [['A', 'all group I and group II causes reasonably ruled out', 2], ['B', 'all 7 group I causes ruled out', 1], ['C', '6 or 5 group I causes ruled out', 0], ['D', 'fewer than 5 group I causes ruled out', -2], ['E', 'another cause is highly probable', -3]]],
  ['e2_rucam_prev', 'E2: RUCAM 6. Is the liver reaction already known for this drug?', [['A', 'labelled in the product information', 2], ['B', 'published but not labelled', 1], ['C', 'unknown', 0]]],
  ['e2_rucam_reexp', 'E2: RUCAM 7. Response to unintentional re-exposure (ALT if hepatocellular, ALP if cholestatic or mixed)', [
    ['A', 'doubled on the drug alone (before re-exposure: ALT below 5 times the upper limit, or ALP below 2 times)', 3],
    ['B', 'doubled with the drugs already given at the first reaction', 1],
    ['C', 'rose but stayed below the upper limit, same conditions as the first reaction', -2],
    ['D', 'not re-exposed, or another situation', 0]]]
];
function rucamTotal_(r) {                                   // '' until the pattern and every item for that scale are answered
  const v = function (k) { return String(r[k] === undefined || r[k] === null ? '' : r[k]).trim().toUpperCase(); };
  const type = v('e2_rucam_type');
  if (type !== 'H' && type !== 'C') return '';
  let t = 0;
  for (let i = 0; i < RUCAM.length; i++) {
    if (RUCAM[i][3] && RUCAM[i][3] !== type) continue;
    const code = v(RUCAM[i][0]);
    const o = RUCAM[i][2].filter(function (x) { return x[0] === code && (!x[3] || x[3] === type); })[0];
    if (!o) return '';
    t += o[2];
  }
  return t;
}
function rucamBand_(n) { return n === '' ? '' : n <= 0 ? 'excluded' : n <= 2 ? 'unlikely' : n <= 5 ? 'possible' : n <= 8 ? 'probable' : 'highly probable'; }
const INACTIVE = ['W', 'L', 'X', 'D'];
const ALERT_COLS = {                     // edits in these columns trigger an immediate alert check
  PHQ_GAD: ['study_id', 'visit', 'declined', 'phq9'],
  LABS: ['study_id', 'visit', 'symptomatic', 'alt', 'alt_uln', 'tbili', 'bili_uln'],
  VISITS: ['study_id', 'visit'].concat(HEP)
};

function col(key, label, type, o) {
  const c = { key: key, label: label, type: type };
  if (o) Object.keys(o).forEach(function (k) { c[k] = o[k]; });
  return c;
}
function tbSymptoms_(sfx) {
  return [col('tb_cough', 'TBscore: cough' + sfx, 'list', { codes: YN }), col('tb_haemoptysis', 'TBscore: haemoptysis' + sfx, 'list', { codes: YN }),
    col('tb_dyspnoea', 'TBscore: breathlessness' + sfx, 'list', { codes: YN }), col('tb_chest_pain', 'TBscore: chest pain' + sfx, 'list', { codes: YN }),
    col('tb_night_sweats', 'TBscore: night sweats' + sfx, 'list', { codes: YN })];
}
function signs_(sfx) {
  return [col('temp_c', 'Temperature, deg C, axillary' + sfx, 'num', { min: 34, max: 42 }),
    col('pulse_min', 'Pulse per minute, counted for a full minute' + sfx, 'int', { min: 30, max: 200 }),
    col('pallor', 'Conjunctival pallor' + sfx, 'list', { codes: PRESENT }),
    col('auscultation', 'Chest auscultation' + sfx, 'list', { codes: AUSC })];
}

// ---------------------------------------------------------------- schema
// kind: screen = screening log; one = one row per participant; long = one row per
// participant per visit; log = free list. pi: true marks columns only the PI writes.
const SCHEMA = [
  { tab: 'S0_SCREEN', kind: 'screen', rows: 1500, title: 'Screening log: every patient assessed, enrolled or not', cols: [
    col('screen_no', 'Screening number, 1, 2, 3 and so on', 'uniqueint', { min: 1, max: 99999 }),
    col('screen_date', 'Date screened', 'date'),
    col('age', 'Age in years', 'int', { min: 10, max: 110 }),
    col('sex', 'Sex', 'list', { codes: SEX }),
    col('smear_grade', 'Sputum smear grade', 'list', { codes: SMEAR }),
    col('eligible', 'Eligible', 'list', { codes: YN }),
    col('excl_code', 'First exclusion criterion met, if not eligible', 'list', { codes: EXCL }),
    col('enrolled', 'Enrolled', 'list', { codes: YN }),
    col('study_id', 'Study number, if enrolled', 'sidnew'),
    col('not_enrolled_reason', 'Reason not enrolled, if eligible', 'list', { codes: [['D', 'declined'], ['C', 'cannot consent'], ['T', 'transferred'], ['O', 'other']] }),
    col('screened_by', 'Screened by (initials)', 'text', { max: 10 })] },

  { tab: 'S1_ENROL', kind: 'one', rows: 400, title: 'Enrolment, demographics and tuberculosis details', cols: [
    col('study_id', 'Study number, as assigned by the custodian in the paper linking log', 'sidnew'),
    col('enrol_date', 'Date enrolled (consent signed)', 'date'),
    col('att_start_date', 'Date ATT started (day 0); every visit window is counted from it', 'date'),
    col('age_years', 'Age in years', 'int', { min: 18, max: 100 }),
    col('sex', 'Sex', 'list', { codes: SEX }),
    col('residence', 'Residence', 'list', { codes: [['U', 'urban'], ['R', 'rural']] }),
    col('education', 'Education', 'list', { codes: [['0', 'none'], ['1', 'primary'], ['2', 'middle'], ['3', 'matric'], ['4', 'intermediate'], ['5', 'graduate or above']] }),
    col('smoking', 'Smoking', 'list', { codes: [['0', 'never'], ['1', 'ex'], ['2', 'current']] }),
    col('alcohol', 'Alcohol', 'list', { codes: [['0', 'never'], ['1', 'past'], ['2', 'current']] }),
    col('pack_years', 'Pack-years (smokers)', 'num', { min: 0, max: 200 }),
    col('dm_status', 'Diabetes at enrolment; fill once the baseline HbA1c is known', 'list', { codes: [['K', 'known: previous physician diagnosis'], ['N', 'new: no previous diagnosis, HbA1c 6.5% or above'], ['0', 'not diabetic']] }),
    col('dm_years', 'Years since diabetes diagnosis (K only)', 'num', { min: 0, max: 70 }),
    col('dm_drugs', 'Diabetes drugs: every letter that applies, in the order M S I O, or 0', 'regex', { pattern: '^(' + DM_DRUGS.join('|') + ')$', width: 4, hint: 'M metformin, S sulfonylurea, I insulin, O other, in that order; 0 none. Example: MS' }),
    col('htn', 'Hypertension', 'list', { codes: YN }),
    col('regimen', 'Regimen as written on the NTP treatment card', 'text', { max: 40 }),
    col('smear_grade', 'Sputum smear grade at diagnosis', 'list', { codes: SMEAR.slice(1) }),
    col('genexpert', 'GeneXpert', 'list', { codes: [['D', 'detected'], ['N', 'not detected'], ['X', 'not done']] }),
    col('rif_res', 'Rifampicin resistance', 'list', { codes: [['D', 'detected'], ['N', 'not detected'], ['I', 'indeterminate'], ['X', 'not done']] }),
    col('optout_questionnaires', 'Depression and anxiety questionnaires on the consent form', 'list', { codes: CONSENT }),
    col('optout_spirometry', 'Lung function (spirometry) on the consent form', 'list', { codes: CONSENT }),
    col('entered_by', 'Entered by (initials)', 'text', { max: 10 })] },

  { tab: 'S2_BASELINE', kind: 'one', rows: 400, title: 'Visit 1: baseline examination, anthropometry and TBscore items', cols: [
    col('study_id', 'Study number', 'sid'),
    col('exam_date', 'Examination date', 'date'),
    col('symptom_weeks', 'Symptom duration in weeks', 'num', { min: 0, max: 260 }),
    col('height_cm', 'Height in cm, shoes off', 'num', { min: 120, max: 210 }),
    col('weight_kg', 'Weight in kg, light clothing, shoes off', 'num', { min: 20, max: 200 }),
    col('waist_cm', 'Waist in cm, midway between the lowest rib and the iliac crest, end of a normal breath out', 'num', { min: 40, max: 200 }),
    col('muac_mm', 'Mid-upper arm circumference in mm, left arm', 'int', { min: 100, max: 500 })]
    .concat(signs_('')).concat([
    col('sbp', 'Systolic blood pressure, mmHg', 'int', { min: 60, max: 260 }),
    col('dbp', 'Diastolic blood pressure, mmHg', 'int', { min: 30, max: 160 }),
    col('rr', 'Respiratory rate per minute', 'int', { min: 6, max: 60 }),
    col('jaundice', 'Jaundice', 'list', { codes: PRESENT })]).concat(tbSymptoms_('')).concat([
    col('examined_by', 'Examined by (initials)', 'text', { max: 10 })]) },

  { tab: 'S3_CXR', kind: 'one', rows: 400, title: 'Baseline chest radiograph. Data entry: study number and date only. Reader scores are pulled in from the reader files every hour', cols: [
    col('study_id', 'Study number', 'sid'),
    col('cxr_date', 'Date of the routine baseline radiograph', 'date'),
    col('r1_pct', 'Reader 1: % of lung field affected (pulled automatically)', 'num', { min: 0, max: 100, pi: true }),
    col('r1_cavity', 'Reader 1: any cavity (pulled automatically)', 'list', { codes: YN, pi: true }),
    col('r1_ncav', 'Reader 1: number of cavities (pulled automatically)', 'int', { min: 0, max: 20, pi: true }),
    col('r2_pct', 'Reader 2: % of lung field affected (pulled automatically)', 'num', { min: 0, max: 100, pi: true }),
    col('r2_cavity', 'Reader 2: any cavity (pulled automatically)', 'list', { codes: YN, pi: true }),
    col('r2_ncav', 'Reader 2: number of cavities (pulled automatically)', 'int', { min: 0, max: 20, pi: true }),
    col('resolution', 'How the two readers\' scores are resolved', 'list', { codes: [['M', 'mean of the two readers'], ['T', 'third reader'], ['D', 'discussion']], pi: true }),
    col('final_override', 'Final Timika score when resolution is T or D', 'num', { min: 0, max: 140, pi: true }),
    col('cavity_final', 'Final cavity when the readers disagree', 'list', { codes: YN, pi: true }),
    col('repeat_read', 'Selected for a repeat read (intra-reader agreement)', 'list', { codes: YN, pi: true }),
    col('entered_by', 'Entered by (initials)', 'text', { max: 10 })] },

  { tab: 'LABS', kind: 'long', rows: 2500, visits: ['V1', 'V2', 'V3', 'V4', 'V5', 'U1', 'U2', 'U3', 'U4', 'U5'],
    title: 'Routine laboratory results: one row per participant per visit. U1 to U5 are unscheduled, symptom-triggered tests', cols: [
    col('study_id', 'Study number', 'sidl', { pair: 'visit' }),
    col('visit', 'Visit: V1 to V5, or U1 to U5 for an unscheduled test', 'pairlist', { values: ['V1', 'V2', 'V3', 'V4', 'V5', 'U1', 'U2', 'U3', 'U4', 'U5'], pair: 'study_id', hint: 'Type V1, V2, V3, V4 or V5; U1 to U5 for unscheduled tests. One row per study number and visit' }),
    col('sample_date', 'Sample date', 'date'),
    col('time_analysed', 'Time analysed, hh:mm', 'time'),
    col('fasting', 'Fasting at the time of the sample (Visit 1)', 'list', { codes: YN }),
    col('symptomatic', 'Hepatotoxicity symptoms when this test was taken (U visits only)', 'list', { codes: YN }),
    col('lab_status', 'Status of this laboratory visit', 'list', { codes: [['1', 'done'], ['2', 'not done'], ['3', 'declined'], ['4', 'sample rejected']] }),
    col('hb', 'Haemoglobin, g/dL', 'num', { min: 3, max: 25 }),
    col('tlc', 'Total leucocyte count, x10^9/L', 'num', { min: 0.5, max: 100 }),
    col('neut_abs', 'Neutrophils, absolute, x10^9/L', 'num', { min: 0, max: 90 }),
    col('neut_pct', 'Neutrophils, %', 'num', { min: 0, max: 100 }),
    col('lymph_abs', 'Lymphocytes, absolute, x10^9/L', 'num', { min: 0, max: 50 }),
    col('lymph_pct', 'Lymphocytes, %', 'num', { min: 0, max: 100 }),
    col('mono_abs', 'Monocytes, absolute, x10^9/L', 'num', { min: 0, max: 20 }),
    col('eos_pct', 'Eosinophils, %', 'num', { min: 0, max: 60 }),
    col('plt', 'Platelets, x10^9/L', 'num', { min: 5, max: 2000 }),
    col('rdw', 'Red cell distribution width, %', 'num', { min: 8, max: 35 }),
    col('mpv', 'Mean platelet volume, fL', 'num', { min: 4, max: 20 }),
    col('hba1c_unit', 'HbA1c unit as printed on the report', 'list', { codes: [['%', 'percent'], ['M', 'mmol/mol']] }),
    col('hba1c', 'HbA1c (choose the unit first)', 'unitnum', { unit: 'hba1c_unit', ranges: { '%': [3, 20], M: [9, 195] } }),
    col('glucose_unit', 'Glucose unit as printed on the report', 'list', { codes: LIPID_UNIT }),
    col('fpg', 'Fasting plasma glucose (choose the unit first)', 'unitnum', { unit: 'glucose_unit', ranges: { M: [30, 800], L: [1.7, 44] } }),
    col('lipid_unit', 'Lipid unit as printed on the report', 'list', { codes: LIPID_UNIT }),
    col('tg', 'Triglycerides (choose the lipid unit first)', 'unitnum', { unit: 'lipid_unit', ranges: { M: [20, 3000], L: [0.2, 34] } }),
    col('hdl', 'HDL cholesterol', 'unitnum', { unit: 'lipid_unit', ranges: { M: [5, 150], L: [0.1, 3.9] } }),
    col('tc', 'Total cholesterol', 'unitnum', { unit: 'lipid_unit', ranges: { M: [50, 600], L: [1.3, 15.5] } }),
    col('ldl', 'LDL cholesterol', 'unitnum', { unit: 'lipid_unit', ranges: { M: [10, 400], L: [0.25, 10.4] } }),
    col('alt', 'ALT, U/L', 'num', { min: 1, max: 5000 }),
    col('ast', 'AST, U/L', 'num', { min: 1, max: 5000 }),
    col('alp', 'ALP, U/L', 'num', { min: 10, max: 3000 }),
    col('tbili', 'Total bilirubin, mg/dL', 'num', { min: 0.05, max: 40 }),
    col('albumin', 'Albumin, g/dL', 'num', { min: 0.5, max: 7 }),
    col('tprotein', 'Total protein, g/dL', 'num', { min: 2, max: 12 }),
    col('alt_uln', 'ALT upper limit of normal printed by this laboratory, U/L', 'num', { min: 10, max: 100 }),
    col('ast_uln', 'AST upper limit of normal printed by this laboratory, U/L', 'num', { min: 10, max: 100 }),
    col('alp_uln', 'ALP upper limit of normal printed by this laboratory, U/L', 'num', { min: 30, max: 500 }),
    col('bili_uln', 'Bilirubin upper limit of normal printed by this laboratory, mg/dL', 'num', { min: 0.5, max: 3 }),
    col('hbsag', 'HBsAg (Visit 1)', 'list', { codes: SEROLOGY }),
    col('anti_hcv', 'Anti-HCV (Visit 1)', 'list', { codes: SEROLOGY }),
    col('hiv', 'HIV (Visit 1)', 'list', { codes: [['N', 'negative'], ['R', 'reactive'], ['X', 'not done']] }),
    col('entered_by', 'Entered by (initials)', 'text', { max: 10 })] },

  { tab: 'VISITS', kind: 'long', rows: 1500, visits: ['V2', 'V3', 'V4', 'V5'],
    title: 'Follow-up visits V2 to V5. Columns marked (V3, V5) are filled only at those visits', cols: [
    col('study_id', 'Study number', 'sidl', { pair: 'visit' }),
    col('visit', 'Visit: V2, V3, V4 or V5', 'pairlist', { values: ['V2', 'V3', 'V4', 'V5'], pair: 'study_id', hint: 'Type V2, V3, V4 or V5. One row per study number and visit' }),
    col('attended', 'Attended', 'list', { codes: YN }),
    col('visit_date', 'Visit date', 'date'),
    col('hep_nausea', 'Hepatotoxicity enquiry: nausea', 'list', { codes: YN }),
    col('hep_vomiting', 'Hepatotoxicity enquiry: vomiting', 'list', { codes: YN }),
    col('hep_anorexia', 'Hepatotoxicity enquiry: loss of appetite', 'list', { codes: YN }),
    col('hep_abdo_pain', 'Hepatotoxicity enquiry: abdominal pain', 'list', { codes: YN }),
    col('hep_dark_urine', 'Hepatotoxicity enquiry: dark urine', 'list', { codes: YN }),
    col('hep_jaundice', 'Hepatotoxicity enquiry: yellow eyes or skin', 'list', { codes: YN }),
    col('hep_fatigue', 'Hepatotoxicity enquiry: unexplained tiredness', 'list', { codes: YN }),
    col('treatment', 'Treatment status', 'list', { codes: [['C', 'continuing as planned'], ['E', 'intensive phase extended'], ['I', 'interrupted'], ['M', 'regimen changed'], ['S', 'stopped']] }),
    col('adherence', 'Adherence', 'list', { codes: [['G', 'good'], ['O', 'occasional misses'], ['F', 'frequent misses']] }),
    col('weight_kg', 'Weight in kg (V3, V5)', 'num', { min: 20, max: 200 }),
    col('waist_cm', 'Waist in cm (V3, V5)', 'num', { min: 40, max: 200 }),
    col('muac_mm', 'Mid-upper arm circumference in mm (V3, V5)', 'int', { min: 100, max: 500 })]
    .concat(signs_(' (V3, V5)')).concat(tbSymptoms_(' (V3, V5)')).concat([
    col('smear_date', 'Sputum smear date (V3 and V5; also V4 while the V3 smear is not negative)', 'date'),
    col('smear_result', 'Sputum smear result (V3 and V5; also V4 while the V3 smear is not negative)', 'list', { codes: SMEAR.concat([['X', 'not done']]) }),
    col('conversion', 'Sputum conversion at V3: never leave blank at V3', 'list', { codes: [['Y', 'converted'], ['N', 'still positive'], ['U', 'cannot assess']] }),
    col('dm_referred', 'Referred for diabetes care (V4)', 'list', { codes: [['Y', 'yes'], ['N', 'no'], ['NA', 'not applicable']] }),
    col('outcome', 'Treatment outcome (V5)', 'list', { codes: [['C', 'cured'], ['T', 'treatment completed'], ['F', 'failed'], ['D', 'died'], ['L', 'lost to follow-up'], ['X', 'transferred out'], ['E', 'not evaluated']] }),
    col('entered_by', 'Entered by (initials)', 'text', { max: 10 })]) },

  { tab: 'SPIRO', kind: 'one', rows: 400, title: 'Visit 5 spirometry, only if smear-negative and not declined', cols: [
    col('study_id', 'Study number', 'sid'),
    col('test_date', 'Test date', 'date'),
    col('spiro_status', 'Spirometry', 'list', { codes: [['Y', 'done'], ['N', 'not done'], ['D', 'declined'], ['C', 'contraindicated']] }),
    col('operator', 'Operator (initials)', 'text', { max: 10 }),
    col('calibrated_today', 'Spirometer calibrated today', 'list', { codes: YN }),
    col('n_acceptable', 'Acceptable manoeuvres (at least 3 needed)', 'int', { min: 0, max: 8 }),
    col('fev1_l', 'FEV1, litres', 'num', { min: 0.2, max: 7 }),
    col('fvc_l', 'FVC, litres', 'num', { min: 0.2, max: 8 }),
    col('fev1_fvc_pct', 'FEV1/FVC, % as printed', 'num', { min: 20, max: 100 }),
    col('fev1_pct_pred', 'FEV1, % predicted as printed', 'num', { min: 10, max: 200 }),
    col('fvc_pct_pred', 'FVC, % predicted as printed', 'num', { min: 10, max: 200 }),
    col('pattern', 'Pattern as printed by the spirometer', 'list', { codes: [['N', 'normal'], ['O', 'obstructive'], ['R', 'restrictive'], ['M', 'mixed']] }),
    col('referred', 'Referred to pulmonology', 'list', { codes: YN }),
    col('entered_by', 'Entered by (initials)', 'text', { max: 10 })] },

  { tab: 'PHQ_GAD', kind: 'long', rows: 800, visits: ['V1', 'V5'],
    title: 'PHQ-9 and GAD-7 item scores. Read each item aloud from the official Urdu form. Do not total. Item 9 above 0: STOP and follow protocol Section 10.2 now', cols: [
    col('study_id', 'Study number', 'sidl', { pair: 'visit' }),
    col('visit', 'Visit: V1 or V5', 'pairlist', { values: ['V1', 'V5'], pair: 'study_id', hint: 'Type V1 or V5. One row per study number and visit' }),
    col('interview_date', 'Interview date', 'date'),
    col('interviewer', 'Interviewer (initials)', 'text', { max: 10 }),
    col('declined', 'Declined the questionnaires today', 'list', { codes: YN })]
    .concat([1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (i) { return col('phq' + i, 'PHQ-9 item ' + i + (i === 9 ? ': above 0 means STOP now' : ''), 'list', { codes: ITEM }); }))
    .concat([1, 2, 3, 4, 5, 6, 7].map(function (i) { return col('gad' + i, 'GAD-7 item ' + i, 'list', { codes: ITEM }); }))
    .concat([col('e1_form_no', 'E1 form number, if item 9 above 0', 'text', { max: 20 })]) },

  { tab: 'EVENTS', kind: 'log', rows: 500, title: 'Events E1 to E4. The signed paper event form remains the full record', cols: [
    col('event_no', 'Event number, 1, 2, 3 and so on', 'uniqueint', { min: 1, max: 9999 }),
    col('study_id', 'Study number', 'sidl'),
    col('event_type', 'Event type', 'list', { codes: [['E1', 'PHQ-9 item 9 alert'], ['E2', 'drug-induced liver injury'], ['E3', 'adverse event from a study procedure'], ['E4', 'withdrawal']] }),
    col('onset_date', 'Onset or trigger date', 'date'),
    col('detected_date', 'Date detected', 'date'),
    col('team_informed', 'Treating team informed', 'list', { codes: YN }),
    col('team_informed_date', 'Date treating team informed', 'date'),
    col('serious', 'Serious adverse event', 'list', { codes: YN }),
    col('e1_risk_assessed', 'E1: same-day risk assessment done', 'list', { codes: YN }),
    col('e1_psych_referral', 'E1: psychiatry referral made', 'list', { codes: YN }),
    col('e2_rucam_type', 'E2: RUCAM injury pattern (R ratio at the event)', 'list', { codes: RUCAM_TYPES }),
    ].concat(RUCAM.map(function (it) { return col(it[0], it[1], 'list', { codes: it[2].map(function (o) { return [o[0], o[1]]; }) }); })).concat([
    col('e2_rucam_score', 'E2: RUCAM total score (one score, added up by the app from the items of the chosen scale)', 'int', { min: -9, max: 14 }),
    col('e2_ctcae', 'E2: CTCAE version 5.0 grade', 'list', { codes: [['1', 'grade 1'], ['2', 'grade 2'], ['3', 'grade 3'], ['4', 'grade 4'], ['5', 'grade 5']] }),
    col('e2_hys_law', 'E2: meets Hy\'s law', 'list', { codes: YN }),
    col('e3_procedure', 'E3: procedure', 'list', { codes: [['SP', 'spirometry'], ['QU', 'questionnaire'], ['AN', 'anthropometry']] }),
    col('e4_choice', 'E4: participant\'s choice about data', 'list', { codes: [['R', 'keep data collected so far'], ['D', 'destroy all data']] }),
    col('outcome', 'Event outcome', 'list', { codes: [['R', 'resolved'], ['O', 'ongoing'], ['S', 'resolved with sequelae'], ['D', 'died']] }),
    col('irb_reported_date', 'Date reported to the IRB (serious events, within 7 days)', 'date'),
    col('entered_by', 'Entered by (initials)', 'text', { max: 10 })]) },

  { tab: 'END_STUDY', kind: 'one', rows: 400, title: 'End of study: one row per participant', cols: [
    col('study_id', 'Study number', 'sid'),
    col('status', 'Status', 'list', { codes: [['C', 'completed all visits'], ['W', 'withdrawn'], ['L', 'lost to follow-up'], ['X', 'transferred out'], ['D', 'died']] }),
    col('status_date', 'Date', 'date'),
    col('retention', 'Data retention for withdrawals', 'list', { codes: [['R', 'keep data collected so far'], ['D', 'destroyed'], ['NA', 'not applicable']] }),
    col('recorded_by', 'Recorded by (initials)', 'text', { max: 10 })] },

  { tab: 'QC_LOG', kind: 'log', rows: 1000, title: 'Source data verification: all critical fields, plus a random 10% of participants for every field', cols: [
    col('qc_no', 'Check number, 1, 2, 3 and so on', 'uniqueint', { min: 1, max: 99999 }),
    col('qc_date', 'Date checked', 'date'),
    col('study_id', 'Study number', 'sidl'),
    col('tab_checked', 'Tab checked', 'list', { codes: [['ALL', 'all tabs'], ['S1_ENROL', ''], ['S2_BASELINE', ''], ['S3_CXR', ''], ['LABS', ''], ['VISITS', ''], ['SPIRO', ''], ['PHQ_GAD', ''], ['EVENTS', '']] }),
    col('visit_checked', 'Visit checked', 'list', { codes: [['ALL', 'all visits'], ['V1', ''], ['V2', ''], ['V3', ''], ['V4', ''], ['V5', '']] }),
    col('fields_checked', 'Fields checked', 'int', { min: 0, max: 500 }),
    col('discrepancies', 'Discrepancies found', 'int', { min: 0, max: 500 }),
    col('corrected', 'All discrepancies corrected', 'list', { codes: YN }),
    col('checker', 'Checked by (initials)', 'text', { max: 10 })] }
];

// Radiograph reader files (one per reader; each reader can open only their own)
const READER = { tab: 'R_SCORES', kind: 'reader', rows: 600, title: 'Chest radiograph scores, one reader', cols: [
  col('study_id', 'Study number of the film', 'rid', { pair: 'read_no' }),
  col('read_no', 'Read number: 1 first read, 2 repeat read (only films the PI marks)', 'pairlist', { values: ['1', '2'], pair: 'study_id', hint: 'Type 1 for the first read, 2 for a repeat read. One row per study number and read number' }),
  col('read_date', 'Date read', 'date'),
  // Percentage of lung affected (Timika score, Ralph et al. Thorax 2010): each quadrant's abnormal opacification estimated by eye,
  // the four added and divided by 4, as applied by Murthy et al. BMC Medicine 2018. [VERIFY against the full Ralph 2010 methods before training the readers.]
  col('q_ru', 'Right upper quadrant: % of abnormal opacification, 0 to 100', 'num', { min: 0, max: 100 }),
  col('q_rl', 'Right lower quadrant: % of abnormal opacification, 0 to 100', 'num', { min: 0, max: 100 }),
  col('q_lu', 'Left upper quadrant: % of abnormal opacification, 0 to 100', 'num', { min: 0, max: 100 }),
  col('q_ll', 'Left lower quadrant: % of abnormal opacification, 0 to 100', 'num', { min: 0, max: 100 }),
  col('pct_lung', 'Percentage of the total lung field affected, 0 to 100: the mean of the four quadrants (calculated, not typed)', 'num', { min: 0, max: 100 }),
  col('cavity', 'Any cavity', 'list', { codes: YN }),
  col('n_cavities', 'Number of cavities', 'int', { min: 0, max: 20 }),
  col('reader_initials', 'Your initials', 'text', { max: 10 })] };

// Calculated tabs: [variable, description, type d date / n number / t text]
const DERIVED = {
  DERIVED_PARTICIPANT: [
    ['study_id', 'Study number', 't'], ['att_start_date', 'Date ATT started (day 0)', 'd'],
    ['dm_status', 'Diabetes at enrolment: K known, N new, 0 not diabetic', 't'],
    ['bmi_v1', 'Body mass index at Visit 1, kg/m2, from weight and height', 'n'],
    ['vai_v1', 'Visceral adiposity index at Visit 1 (Amato 2010): sex-specific, from waist, BMI, triglycerides and HDL in mmol/L', 'n'],
    ['tbscore_v1_p90', 'Bandim TBscore at Visit 1 (0 to 13), pulse threshold above 90 per minute', 'n'],
    ['tbscore_v1_p100', 'Bandim TBscore at Visit 1, pulse threshold above 100 per minute (sensitivity analysis)', 'n'],
    ['tbscore_v3_p90', 'Bandim TBscore at Visit 3, pulse above 90', 'n'], ['tbscore_v3_p100', 'Bandim TBscore at Visit 3, pulse above 100', 'n'],
    ['tbscore_v5_p90', 'Bandim TBscore at Visit 5, pulse above 90', 'n'], ['tbscore_v5_p100', 'Bandim TBscore at Visit 5, pulse above 100', 'n'],
    ['timika_r1', 'Timika score, reader 1: % lung affected, plus 40 if any cavity', 'n'], ['timika_r2', 'Timika score, reader 2', 'n'],
    ['timika_final', 'Final Timika score: mean of the readers if resolution is M, otherwise the score entered by the PI', 'n'],
    ['cavity_final', 'Final cavity: the PI\'s decision, or the readers\' value when they agree', 't'],
    ['phq9_v1', 'PHQ-9 total at Visit 1 (0 to 27); blank if declined or any item missing', 'n'], ['gad7_v1', 'GAD-7 total at Visit 1 (0 to 21)', 'n'],
    ['phq9_v5', 'PHQ-9 total at Visit 5', 'n'], ['gad7_v5', 'GAD-7 total at Visit 5', 'n'],
    ['item9_positive', 'Y if PHQ-9 item 9 was above 0 at any visit', 't'],
    ['hba1c_v4_pct', 'HbA1c at Visit 4 in percent (mmol/mol converted as 0.09148 x value + 2.152)', 'n'],
    ['dm_class_v4', 'Diabetes at month 3: P persistent, T transient, K known, X newly found, 0 not diabetic', 't'],
    ['end_status', 'Status from END_STUDY', 't']],
  DERIVED_LABS: [
    ['study_id', 'Study number', 't'], ['visit', 'Visit', 't'], ['sample_date', 'Sample date', 'd'],
    ['day_no', 'Days from the date ATT started to the sample', 'n'], ['in_window', 'Y if the sample falls in the visit window', 't'],
    ['nlr', 'Neutrophil-to-lymphocyte ratio (absolute counts)', 'n'], ['plr', 'Platelet-to-lymphocyte ratio', 'n'],
    ['mlr', 'Monocyte-to-lymphocyte ratio', 'n'], ['sii', 'Systemic immune-inflammation index: platelets x neutrophils / lymphocytes', 'n'],
    ['siri', 'Systemic inflammation response index: neutrophils x monocytes / lymphocytes', 'n'],
    ['alt_x_uln', 'ALT as a multiple of the laboratory upper limit of normal', 'n'], ['bili_x_uln', 'Bilirubin as a multiple of the upper limit of normal', 'n'],
    ['dili', 'MET with the limb that was met; CHECK if ALT is 3x ULN or more and the symptom enquiry is not recorded', 't']],
  DERIVED_VISITS: [
    ['study_id', 'Study number', 't'], ['visit', 'Visit', 't'], ['visit_date', 'Visit date', 'd'],
    ['day_no', 'Days from the date ATT started', 'n'], ['target_day', 'Target day', 'n'],
    ['in_window', 'Y if the visit falls in its window', 't'], ['hep_symptoms_any', 'Y if any hepatotoxicity symptom; blank if the enquiry is incomplete', 't']],
  SCHEDULE: [
    ['study_id', 'Study number', 't'], ['visit', 'Visit', 't'], ['target_date', 'Target date', 'd'],
    ['window_start', 'Window opens', 'd'], ['window_end', 'Window closes', 'd'],
    ['status', 'overdue (window closed, not recorded); due now (window open); upcoming (opens within 14 days)', 't']],
  QUERIES: [
    ['study_id', 'Study number', 't'], ['tab', 'Tab to check', 't'], ['row', 'Row number in that tab', 'n'],
    ['visit', 'Visit', 't'], ['check', 'What needs checking', 't'], ['detail', 'Detail', 't'],
    ['field', 'Column to check', 't'], ['go', 'Link: opens the tab at the exact cell', 'f']],
  SUMMARY: [['item', 'Item', 't'], ['value', 'Value', 't']]
};
const ALERT_SPEC = [['alert_key', 't'], ['type', 't'], ['study_id', 't'], ['visit', 't'], ['rule', 't'], ['detected_at', 'x'],
  ['emailed_to', 't'], ['action_by', 't'], ['action_date', 'd'], ['note', 't']];

const README_TEXT = [
  'TB-DM COHORT, LAHORE GENERAL HOSPITAL: ELECTRONIC DATA SYSTEM v' + CFG.VERSION,
  '',
  'THE RULE THAT NEVER BENDS',
  'Never type a name, CNIC, telephone number, address or MRN anywhere in this workbook. Study number only.',
  'Consent forms, the Core Per-Patient File (with the MRN), the paper event forms and the linking log stay on paper, locked away.',
  '',
  'ENTERING DATA',
  '1. The custodian assigns the next study number in the paper linking log. Enter it in S1_ENROL first: every other tab accepts only study numbers already in S1_ENROL.',
  '2. Every column header has a note giving its meaning and allowed codes (hover on a computer; tap the header on a phone). The CODEBOOK tab lists them all. Wrong entries are rejected.',
  '3. Enter raw values exactly as measured or as printed on the report. Never calculate: BMI, TBscore, ratios, totals, visit days and flags are calculated by the system.',
  '4. Laboratory values: choose the unit first, then type the value, and the laboratory upper limit of normal.',
  '5. LABS, VISITS and PHQ_GAD have one row per participant per visit. Type the visit code exactly: V1 to V5, or U1 to U5 for unscheduled tests in LABS.',
  '6. To correct a value, type over it. The old value, the new value and the time are logged automatically. Never delete rows or columns: tell the PI.',
  '7. To paste, use Paste special > Values only (Ctrl+Shift+V, or Cmd+Shift+V on a Mac). A plain paste removes the checks from those cells.',
  '8. If something was not done, leave the cell blank and record why in the status column: lab_status, attended, declined or spiro_status.',
  '',
  'SAFETY: THE SYSTEM ONLY BACKS YOU UP',
  'PHQ-9 item 9 above 0: stop, stay with the participant, call the supervising clinician, same-day assessment (protocol Section 10.2), then form E1.',
  'A liver result meeting the definition: tell the treating team the same day (protocol Section 7.7), then form E2.',
  'The e-mail alerts and the ALERTS tab never replace these steps.',
  '',
  'TABS',
  'S0_SCREEN every patient assessed | S1_ENROL enrolment | S2_BASELINE Visit 1 examination | S3_CXR radiograph record (readers score in their own files)',
  'LABS routine results at every visit | VISITS follow-up visits V2 to V5 | SPIRO Visit 5 spirometry | PHQ_GAD questionnaires at V1 and V5',
  'EVENTS summary of forms E1 to E4 | END_STUDY end of study | QC_LOG source data verification',
  'Read-only, recalculated every hour: SCHEDULE (visits due or overdue), QUERIES (entries to check), SUMMARY, ALERTS, DERIVED_PARTICIPANT, DERIVED_LABS, DERIVED_VISITS',
  '',
  'EVERY WEEK',
  'Data collector: work through SCHEDULE and QUERIES. Custodian: source data verification, recorded in QC_LOG. PI: ALERTS, QUERIES, the audit log and the weekly export e-mail.',
  '',
  'PHONES AND OFFLINE USE',
  'One device per person. Never let two people edit the same tab while offline. Reconnect and let the app sync before leaving the clinic each day.',
  'If the system cannot be reached at all, write the values on the laboratory report or a plain sheet, sign and date it, enter them the same day, and keep that sheet as the source document.',
  '',
  'ACCESS',
  'Each person uses their own Google account with 2-Step Verification switched on. Never share a login. Lock phones and computers. Report a lost phone to the PI the same day.',
  'Only the PI changes sharing, restores earlier versions (File > Version history) or runs the TB-DM Study menu.'
];
const READER_TEXT = [
  'TB-DM COHORT: CHEST RADIOGRAPH SCORING, READER FILE',
  '',
  'Score only the routine baseline chest radiograph of each study number the PI gives you.',
  'Do not look at clinical, laboratory or diabetes information, or at the other reader\'s scores. Nobody except you and the PI can open this file.',
  'One row per film in R_SCORES: study number; read number (1 for the first read, 2 only for films the PI marks for a repeat read); date read;',
  'percentage of the total lung field affected (0 to 100); any cavity (Y or N); number of cavities (0 when there is no cavity, 1 or more when there is one); your initials.',
  'Do not calculate the Timika score: the system adds 40 when there is a cavity.',
  'To correct a value, type over it. Every change is logged.'
];

// ============================================================================
//  PURE LOGIC (no Google services; tested outside Apps Script)
// ============================================================================
function colLetter_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function code_(v) { return str_(v).toUpperCase(); }
function num_(v) { const s = str_(v).replace(/,/g, ''); if (s === '') return null; const x = Number(s); return isFinite(x) ? x : null; }
function round_(x, d) { if (x === null || x === undefined || x === '' || !isFinite(x)) return ''; const f = Math.pow(10, d); return Math.round(x * f) / f; }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function dayNo_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str_(iso)); if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]), d = new Date(t);
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return Math.round(t / 864e5);
}
function isoOf_(day) { const d = new Date(day * 864e5); return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate()); }
function diff_(a, b) { const x = dayNo_(a), y = dayNo_(b); return x === null || y === null ? null : y - x; }
function minutes_(t) { const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(str_(t)); if (!m || +m[1] > 23 || +m[2] > 59) return null; return +m[1] * 60 + +m[2]; }
function idOk_(s) { const m = new RegExp('^' + CFG.ID_PREFIX + '(\\d{3})$').exec(code_(s)); return !!m && +m[1] >= 1 && +m[1] <= CFG.ID_MAX; }
function idOf_(k) { return CFG.ID_PREFIX + ('00' + k).slice(-3); }
function inWindow_(visit, day) { const w = CFG.WINDOWS[visit]; if (!w || day === null) return ''; return day >= w[1] && day <= w[2] ? 'Y' : 'N'; }
// Visceral adiposity index (Amato MC et al., Diabetes Care 2010;33:920-2, doi 10.2337/dc09-1825; equations as printed in
// Amato et al., Lipids Health Dis 2011;10:183, doi 10.1186/1476-511X-10-183). Waist in cm; triglycerides and HDL in mmol/L.
// mg/dL is converted with the NIDDK factors (triglycerides x 0.0113, cholesterol x 0.0259). Blank if anything is missing.
function vai_(sex, waist, w, h, tg, hdl, unit) {
  const wc = num_(waist), kg = num_(w), cm = num_(h), t = num_(tg), d = num_(hdl), sx = code_(sex), u = code_(unit);
  if (wc === null || kg === null || cm === null || cm <= 0 || t === null || d === null || d <= 0 || (sx !== 'M' && sx !== 'F') || (u !== 'M' && u !== 'L')) return '';
  const bmi = kg / Math.pow(cm / 100, 2), tgm = u === 'M' ? t * 0.0113 : t, hdm = u === 'M' ? d * 0.0259 : d;
  const v = sx === 'M' ? (wc / (39.68 + 1.88 * bmi)) * (tgm / 1.03) * (1.31 / hdm) : (wc / (36.58 + 1.89 * bmi)) * (tgm / 0.81) * (1.52 / hdm);
  return round_(v, 2);
}
// Follow-up smears are taken at V3 and V5; while the V3 smear is not negative, it is repeated at V4 too (PI's rule: repeat until a negative smear is documented).
function smearDue_(v, v3result) { return v === 'V3' || v === 'V5' || (v === 'V4' && code_(v3result) !== 'N'); }
function bmi_(w, h) { const kg = num_(w), cm = num_(h); if (kg === null || cm === null || cm <= 0) return ''; return round_(kg / Math.pow(cm / 100, 2), 1); }
function ratio_(a, b) { const x = num_(a), y = num_(b); return x === null || y === null || y <= 0 ? '' : round_(x / y, 2); }
function timika_(pct, cavity) { const p = num_(pct), c = code_(cavity); if (p === null || (c !== 'Y' && c !== 'N')) return ''; return p + (c === 'Y' ? 40 : 0); }

function tbscore_(r, bmi, pulseLimit) {                     // Bandim TBscore, 0 to 13; blank if any item missing
  const need = TB_SYMPTOMS.concat(['pallor', 'auscultation', 'temp_c', 'pulse_min', 'muac_mm']);
  for (let i = 0; i < need.length; i++) if (str_(r[need[i]]) === '') return '';
  if (bmi === '' || bmi === null) return '';
  let s = 0;
  TB_SYMPTOMS.forEach(function (k) { if (code_(r[k]) === 'Y') s++; });
  if (code_(r.pallor) === 'P') s++;
  if (code_(r.auscultation) === 'P') s++;
  if (num_(r.temp_c) > 37) s++;
  if (num_(r.pulse_min) > pulseLimit) s++;
  if (bmi < 18) s++;
  if (bmi < 16) s++;
  const m = num_(r.muac_mm);
  if (m < 220) s++;
  if (m < 200) s++;
  return s;
}
function ratios_(r) {
  const n = num_(r.neut_abs), l = num_(r.lymph_abs), m = num_(r.mono_abs), p = num_(r.plt), ok = l !== null && l > 0;
  return {
    nlr: ok && n !== null ? round_(n / l, 2) : '', plr: ok && p !== null ? round_(p / l, 1) : '', mlr: ok && m !== null ? round_(m / l, 3) : '',
    sii: ok && n !== null && p !== null ? round_(p * n / l, 1) : '', siri: ok && n !== null && m !== null ? round_(n * m / l, 3) : ''
  };
}
// ATS 2006 limbs, plus the DILI Expert Working Group bilirubin limb, attributed separately in the protocol
function diliStatus_(alt, altUln, bili, biliUln, symptomatic) {
  const a = num_(alt), au = num_(altUln);
  if (a === null || au === null || au <= 0) return '';
  const x = a / au, b = num_(bili), bu = num_(biliUln), bx = b !== null && bu !== null && bu > 0 ? b / bu : null;
  if (x >= 5) return 'MET: ALT 5x ULN or more';
  if (x >= 3 && symptomatic === true) return 'MET: ALT 3x ULN or more with symptoms or jaundice';
  if (x >= 3 && bx !== null && bx > 2) return 'MET: ALT 3x ULN or more with bilirubin above 2x ULN';
  if (x >= 3 && symptomatic === null) return 'CHECK: ALT 3x ULN or more and the symptom enquiry is not recorded';
  return '';
}
function hba1cPct_(v, unit) { const x = num_(v); if (x === null) return ''; return code_(unit) === 'M' ? round_(x * 0.09148 + 2.152, 2) : x; }
function dmClassV4_(baseline, pct) {
  const b = code_(baseline);
  if (b === 'K') return 'K';
  if (pct === '' || pct === null) return '';
  if (b === 'N') return pct >= 6.5 ? 'P' : 'T';
  if (b === '0') return pct >= 6.5 ? 'X' : '0';
  return '';
}
function sumItems_(r, prefix, n) { let s = 0; for (let i = 1; i <= n; i++) { const v = num_(r[prefix + i]); if (v === null) return ''; s += v; } return s; }
function hepAny_(r) {                                       // true, false, or null when the enquiry is incomplete
  let any = false, all = true;
  HEP.forEach(function (k) { const v = code_(r[k]); if (v === 'Y') any = true; if (v === '') all = false; });
  if (any) return true;
  return all ? false : null;
}

function validateValue_(c, v, row, ctx) {                   // '' when acceptable; blank cells are always acceptable here
  const s = str_(v);
  if (s === '') return '';
  if (c.codes) return c.codes.some(function (p) { return p[0] === s.toUpperCase(); }) ? '' : 'is not an allowed code';
  if (c.key === 'n_cavities' && row && num_(s) !== null) {      // the cavity count must agree with the cavity answer
    const cv = code_(row.cavity), nx = num_(s);
    if (cv === 'N' && nx !== 0) return 'must be 0 when there is no cavity';
    if (cv === 'Y' && nx < 1) return 'must be 1 or more when there is a cavity';
  }
  switch (c.type) {
    case 'num': case 'int': case 'uniqueint': {
      const x = num_(s);
      if (x === null) return 'is not a number';
      if (c.type !== 'num' && x !== Math.floor(x)) return 'is not a whole number';
      return x < c.min || x > c.max ? 'is outside ' + c.min + ' to ' + c.max : '';
    }
    case 'date': {
      const d = dayNo_(s);
      if (d === null) return 'is not a date';
      if (d < dayNo_(CFG.EARLIEST)) return 'is before ' + CFG.EARLIEST;
      return ctx && ctx.today !== null && ctx.today !== undefined && d > ctx.today ? 'is in the future' : '';
    }
    case 'time': return minutes_(s) === null ? 'is not a time (hh:mm)' : '';
    case 'text': return s.length > c.max ? 'is longer than ' + c.max + ' characters' : '';
    case 'regex': return new RegExp(c.pattern).test(s.toUpperCase()) ? '' : 'is not in the required form';
    case 'sidnew': case 'rid': return idOk_(s) ? '' : 'is not a valid study number';
    case 'sid': case 'sidl':
      if (!idOk_(s)) return 'is not a valid study number';
      return ctx && ctx.enrolled && !ctx.enrolled[s.toUpperCase()] ? 'is not in S1_ENROL' : '';
    case 'pairlist': return c.values.indexOf(s.toUpperCase()) >= 0 ? '' : 'is not an allowed value';
    case 'unitnum': {
      const u = code_(row && row[c.unit]), rg = c.ranges[u], x = num_(s);
      if (!u) return 'has no unit chosen';
      if (!rg) return 'has an unrecognised unit';
      if (x === null) return 'is not a number';
      return x < rg[0] || x > rg[1] ? 'is outside ' + rg[0] + ' to ' + rg[1] + ' for that unit' : '';
    }
  }
  return '';
}

// A radiograph score is usable only when it is complete: date, lung percentage, cavity answer, and the count when there is a cavity.
const QUADRANTS = ['q_ru', 'q_rl', 'q_lu', 'q_ll'];
// The percentage of lung affected from the four quadrant estimates: their mean, to 1 decimal; '' until all four are entered.
function pctFromQuadrants_(v) {
  const q = QUADRANTS.map(function (k) { return num_(v[k]); });
  if (q.some(function (x) { return x === null; })) return '';
  return String(round_((q[0] + q[1] + q[2] + q[3]) / 4, 1));
}
// strict (a new or changed read): all four quadrants are needed. Otherwise an older read typed as one percentage still counts.
function readerGaps_(v, strict) {
  const g = {};
  if (str_(v.read_date) === '') g.read_date = 'is required';
  if (strict || QUADRANTS.some(function (k) { return str_(v[k]) !== ''; })) QUADRANTS.forEach(function (k) { if (str_(v[k]) === '') g[k] = 'is required'; });
  else if (str_(v.pct_lung) === '') g.pct_lung = 'is required';
  if (code_(v.cavity) === '') g.cavity = 'is required';
  else if (code_(v.cavity) === 'Y' && str_(v.n_cavities) === '') g.n_cavities = 'is required when there is a cavity';
  return g;
}

// data: { TAB: [row objects with string values and _row] }; today: 'yyyy-mm-dd'
// Which column a query points at: the first rule whose pattern matches the check and whose column exists in that tab.
// Checks that list column names in their detail (missing items, invalid entries) point at the first one named.
const QUERY_FIELD = [
  // queries about data missing in another record: the link opens the cell where the fix belongs
  [/Visit 5 is not recorded as attended/, 'attended'], [/^Died: record/, 'outcome'], [/Withdrawn but no E4/, 'event_type'],
  [/Liver symptoms recorded but no liver test/, 'alt'], [/No laboratory row for this visit/, 'sample_date'],
  [/^Reader 1 cavity count/, 'r1_ncav'], [/^Reader 2 cavity count/, 'r2_ncav'],
  [/^Row without a study number|^Enrolled but no study number|^No screening line|^Study number|^Screened eligible/, 'study_id'], [/^Enrolled although/, 'eligible'], [/exclusion code/, 'excl_code'],
  [/not enrolled, but no reason/, 'not_enrolled_reason'], [/^Age differs/, 'age_years'], [/^Sex differs/, 'sex'], [/^Smear grade differs/, 'smear_grade'],
  [/Date ATT started missing/, 'att_start_date'], [/Enrolled more than 7 days/, 'enrol_date'], [/Diabetes status|New diabetes|Not diabetic but baseline|fasting glucose in the diabetic/, 'dm_status'],
  [/duration or drugs missing/, 'dm_years'], [/diabetes drugs recorded/, 'dm_drugs'], [/pack-years recorded/, 'pack_years'],
  [/HIV reactive/, 'hiv'], [/Hepatitis B or C/, 'hbsag'], [/Raised liver tests|ALT or AST above 3/, 'alt'], [/examination outside/, 'exam_date'], [/^BMI outside|Weight changed|Weight missing/, 'weight_kg'],
  [/Waist changed/, 'waist_cm'], [/MUAC changed/, 'muac_mm'], [/Attendance not recorded|not attended/, 'attended'],
  [/Visit date missing|Visit outside its window|dated before the previous|Visit date before ATT|No laboratory row for this visit|visit not recorded/, 'visit_date'],
  [/Hepatotoxicity symptom enquiry|Liver symptoms recorded/, 'hep_nausea'], [/repeat the smear at V4/, 'smear_result'], [/conversion|Conversion/, 'conversion'], [/Smear result without/, 'smear_date'], [/Smear date without/, 'smear_result'],
  [/V5 smear positive|Outcome cured|Outcome failed|Treatment completed, but|Treatment outcome|outcome died|still ongoing/, 'outcome'],
  [/laboratory status|Laboratory status/, 'lab_status'], [/Symptom status missing/, 'symptomatic'], [/Sample outside/, 'sample_date'],
  [/Neutrophil and lymphocyte percentages|Neutrophil percentage/, 'neut_pct'], [/Lymphocyte percentage/, 'lymph_pct'], [/Absolute counts exceed/, 'tlc'], [/Absolute neutrophil/, 'neut_abs'],
  [/ALT upper limit/, 'alt_uln'], [/AST upper limit/, 'ast_uln'], [/ALP upper limit/, 'alp_uln'], [/Bilirubin upper limit/, 'bili_uln'], [/HDL or LDL/, 'hdl'],
  [/Fasting status/, 'fasting'], [/Baseline HbA1c/, 'hba1c'], [/Baseline serology/, 'hbsag'],
  [/Declined|Questionnaire entered but/, 'declined'], [/Questionnaire incomplete/, 'phq1'], [/Item 9 above 0 but no E1 event/, 'phq9'], [/E1 form number/, 'e1_form_no'], [/Interview outside/, 'interview_date'],
  [/Spirometry test date|Spirometry outside/, 'test_date'], [/Spirometry status|Visit 5 smear is not|consent form says declined/, 'spiro_status'], [/FEV1 or FVC|FEV1 greater/, 'fev1_l'], [/FEV1\/FVC/, 'fev1_fvc_pct'], [/Fewer than 3/, 'n_acceptable'],
  [/need resolution|no final Timika/, 'resolution'], [/Final Timika/, 'final_override'], [/cavity/, 'cavity_final'], [/not yet scored/, 'r1_pct'],
  [/Event type missing|E1 recorded but|E2 recorded but/, 'event_type'], [/IRB/, 'irb_reported_date'], [/Same-day risk/, 'e1_risk_assessed'], [/Treating team not recorded/, 'team_informed'],
  [/informed before|informed missing/, 'team_informed_date'], [/Detected before/, 'detected_date'], [/RUCAM/, 'e2_rucam_type'], [/Hy's law/, 'e2_hys_law'],
  [/Withdrawal data choice/, 'e4_choice'], [/Withdrawal data choice/, 'retention'], [/End-of-study date|after the end-of-study date/, 'status_date'],
  [/recorded by blank/, 'recorded_by'], [/Completed, but|Withdrawn but|Died:|other open quer|does not match the end-of-study|no end-of-study row/, 'status']
];
function queryField_(tab, check, detail) {
  const def = SCHEMA.filter(function (t) { return t.tab === tab; })[0]; if (!def) return '';
  const keys = def.cols.map(function (c) { return c.key; });
  const first = str_(detail).split(/[ ,]/)[0];                 // "regimen, htn" or "sample_date is before ..." name the column first
  if (/fields blank|items missing|Tests expected|Invalid entry|Duplicate/.test(check) && keys.indexOf(first) >= 0) return first;
  for (let i = 0; i < QUERY_FIELD.length; i++) if (QUERY_FIELD[i][0].test(check) && keys.indexOf(QUERY_FIELD[i][1]) >= 0) return QUERY_FIELD[i][1];
  return keys.indexOf(first) >= 0 ? first : '';
}

function computeDerived_(data, today, held) {
  const T = function (n) { return data[n] || []; };
  const tday = dayNo_(today);
  const byId = function (rows) { const m = {}; rows.forEach(function (r) { if (r.study_id && !m[r.study_id]) m[r.study_id] = r; }); return m; };
  const byVisit = function (rows) { const m = {}; rows.forEach(function (r) { const k = r.study_id + '|' + r.visit; if (r.study_id && r.visit && !m[k]) m[k] = r; }); return m; };
  const enrol = byId(T('S1_ENROL')), base = byId(T('S2_BASELINE')), cxr = byId(T('S3_CXR')), end = byId(T('END_STUDY'));
  const labs = byVisit(T('LABS')), visits = byVisit(T('VISITS')), phq = byVisit(T('PHQ_GAD'));
  const events = T('EVENTS'), screen = T('S0_SCREEN');
  const out = { participant: [], labs: [], visits: [], schedule: [], queries: [], summary: [], alerts: [] };
  const Q = function (sid, tab, row, visit, check, detail) { out.queries.push([sid || '', tab, row || '', visit || '', check, detail || '']); };
  const hasEvent = function (sid, type) { return events.some(function (e) { return e.study_id === sid && e.event_type === type; }); };
  const pctV1 = function (sid) { const l = labs[sid + '|V1']; return l ? hba1cPct_(l.hba1c, l.hba1c_unit) : ''; };
  const ids = Object.keys(enrol).sort();

  // ---- one row per participant
  ids.forEach(function (sid) {
    const e = enrol[sid], b = base[sid] || {}, c = cxr[sid] || {};
    const bmi1 = bmi_(b.weight_kg, b.height_cm);
    const v3 = visits[sid + '|V3'] || {}, v5 = visits[sid + '|V5'] || {};
    const bmi3 = bmi_(v3.weight_kg, b.height_cm), bmi5 = bmi_(v5.weight_kg, b.height_cm);
    const t1 = timika_(c.r1_pct, c.r1_cavity), t2 = timika_(c.r2_pct, c.r2_cavity);
    let tf = '';
    if (c.resolution === 'M' && t1 !== '' && t2 !== '') tf = round_((t1 + t2) / 2, 1);
    else if ((c.resolution === 'T' || c.resolution === 'D') && num_(c.final_override) !== null) tf = num_(c.final_override);
    const cav = c.cavity_final || (c.r1_cavity && c.r1_cavity === c.r2_cavity ? c.r1_cavity : '');
    const p1 = phq[sid + '|V1'] || {}, p5 = phq[sid + '|V5'] || {};
    const tot = function (r, p, n) { return r.declined === 'Y' ? '' : sumItems_(r, p, n); };
    const pos9 = function (r) { return r.declined !== 'Y' && num_(r.phq9) !== null && num_(r.phq9) > 0; };
    const l4 = labs[sid + '|V4'] || {}, a4 = hba1cPct_(l4.hba1c, l4.hba1c_unit);
    const l1 = labs[sid + '|V1'] || {};
    out.participant.push([sid, e.att_start_date || '', e.dm_status || '', bmi1, vai_(e.sex, b.waist_cm, b.weight_kg, b.height_cm, l1.tg, l1.hdl, l1.lipid_unit),
      tbscore_(b, bmi1, CFG.PULSE_PRIMARY), tbscore_(b, bmi1, CFG.PULSE_SENSITIVITY),
      tbscore_(v3, bmi3, CFG.PULSE_PRIMARY), tbscore_(v3, bmi3, CFG.PULSE_SENSITIVITY),
      tbscore_(v5, bmi5, CFG.PULSE_PRIMARY), tbscore_(v5, bmi5, CFG.PULSE_SENSITIVITY),
      t1, t2, tf, cav, tot(p1, 'phq', 9), tot(p1, 'gad', 7), tot(p5, 'phq', 9), tot(p5, 'gad', 7),
      pos9(p1) || pos9(p5) ? 'Y' : '', a4, dmClassV4_(e.dm_status, a4), (end[sid] || {}).status || '']);
    [['V1', p1], ['V5', p5]].forEach(function (x) {
      if (pos9(x[1])) out.alerts.push({ key: 'E1|' + sid + '|' + x[0], type: 'E1', study_id: sid, visit: x[0], rule: 'PHQ-9 item 9 = ' + num_(x[1].phq9) });
    });
  });

  // ---- visits
  T('VISITS').forEach(function (r) {
    if (!r.study_id || !r.visit) return;
    const d = diff_((enrol[r.study_id] || {}).att_start_date, r.visit_date), w = CFG.WINDOWS[r.visit], any = hepAny_(r);
    out.visits.push([r.study_id, r.visit, r.visit_date || '', d === null ? '' : d, w ? w[0] : '', inWindow_(r.visit, d), any === null ? '' : (any ? 'Y' : 'N')]);
  });

  // ---- laboratory: ratios, liver injury definition, alerts
  const diliMet = {};
  T('LABS').forEach(function (r) {
    if (!r.study_id || !r.visit) return;
    const sid = r.study_id, v = r.visit, unscheduled = /^U/.test(v);
    const d = diff_((enrol[sid] || {}).att_start_date, r.sample_date), q = ratios_(r);
    let symp = null;
    if (unscheduled) symp = r.symptomatic === 'Y' ? true : (r.symptomatic === 'N' ? false : null);
    else if (visits[sid + '|' + v]) symp = hepAny_(visits[sid + '|' + v]);
    const dili = v === 'V1' ? '' : diliStatus_(r.alt, r.alt_uln, r.tbili, r.bili_uln, symp);
    out.labs.push([sid, v, r.sample_date || '', d === null ? '' : d, unscheduled ? '' : inWindow_(v, d),
      q.nlr, q.plr, q.mlr, q.sii, q.siri, ratio_(r.alt, r.alt_uln), ratio_(r.tbili, r.bili_uln), dili]);
    if (dili.indexOf('MET') === 0) {
      diliMet[sid] = v;
      out.alerts.push({ key: 'E2|' + sid + '|' + v, type: 'E2', study_id: sid, visit: v, rule: dili });
    } else if (dili.indexOf('CHECK') === 0) {
      out.alerts.push({ key: 'E2-check|' + sid + '|' + v, type: 'E2-check', study_id: sid, visit: v, rule: dili });
    }
  });

  // ---- schedule of visits not yet recorded
  ids.forEach(function (sid) {
    const st = (end[sid] || {}).status || '';
    if (st === 'C' || INACTIVE.indexOf(st) >= 0) return;
    const d0 = dayNo_(enrol[sid].att_start_date);
    if (d0 === null || tday === null) return;
    ['V1', 'V2', 'V3', 'V4', 'V5'].forEach(function (v) {
      if (v === 'V1' ? base[sid] : visits[sid + '|' + v]) return;
      const w = CFG.WINDOWS[v], s = d0 + w[1], en = d0 + w[2];
      let status = '';
      if (tday > en) status = 'overdue'; else if (tday >= s) status = 'due now'; else if (s - tday <= CFG.UPCOMING_DAYS) status = 'upcoming';
      if (status) out.schedule.push([sid, v, isoOf_(d0 + w[0]), isoOf_(s), isoOf_(en), status]);
    });
  });
  out.schedule.sort(function (a, b) { return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); });

  // ---- queries 1: every value against the schema (catches anything that bypassed validation, such as a plain paste)
  const ctx = { enrolled: enrol, today: tday };
  SCHEMA.forEach(function (t) {
    const seen = {}, hasSid = t.cols.some(function (c) { return c.key === 'study_id'; });
    T(t.tab).forEach(function (r) {
      if (t.tab === 'END_STUDY' && r.retention === 'D') return;      // record of a destroyed participant: nothing else exists to match
      if (hasSid && !r.study_id && t.tab !== 'S0_SCREEN') Q('', t.tab, r._row, r.visit, 'Row without a study number', 'enter the study number or clear the row');
      t.cols.forEach(function (c) {
        const msg = validateValue_(c, r[c.key], r, ctx);
        if (msg) Q(r.study_id, t.tab, r._row, r.visit, 'Invalid entry', c.key + ' ' + msg);
        if ((c.type === 'uniqueint' || c.type === 'sidnew' || c.type === 'sid') && r[c.key]) {
          const k = c.key + '=' + r[c.key];
          if (seen[k]) Q(r.study_id, t.tab, r._row, r.visit, 'Duplicate', c.key + ' ' + r[c.key] + ' is also in row ' + seen[k]); else seen[k] = r._row;
        }
      });
      if (t.kind === 'long' && r.study_id && r.visit) {
        const k = 'visit=' + r.study_id + '|' + r.visit;
        if (seen[k]) Q(r.study_id, t.tab, r._row, r.visit, 'Duplicate', 'this study number and visit are also in row ' + seen[k]); else seen[k] = r._row;
      }
    });
  });

  // ---- queries 2: consistency and completeness
  const screenIds = {};
  screen.forEach(function (r) {
    if (r.study_id) screenIds[r.study_id] = true;
    if (r.enrolled === 'Y' && !r.study_id) Q('', 'S0_SCREEN', r._row, '', 'Enrolled but no study number', '');
    if (r.enrolled === 'Y' && r.eligible === 'N') Q(r.study_id, 'S0_SCREEN', r._row, '', 'Enrolled although marked not eligible', '');
    if (r.eligible === 'N' && !r.excl_code) Q(r.study_id, 'S0_SCREEN', r._row, '', 'Not eligible but no exclusion code', '');
    if (r.eligible === 'Y' && r.enrolled === 'N' && !r.not_enrolled_reason) Q('', 'S0_SCREEN', r._row, '', 'Eligible and not enrolled, but no reason', '');
    if (r.study_id && !enrol[r.study_id] && r.eligible !== 'N' && r.enrolled !== 'N') Q(r.study_id, 'S0_SCREEN', r._row, '', 'Screened eligible and agreed, not yet enrolled', '');   // not for someone correctly screened out or who declined: they are not meant to be enrolled
  });
  const destroyed = {};
  T('END_STUDY').forEach(function (r) { if (r.retention === 'D' && r.study_id) destroyed[r.study_id] = true; });
  ids.forEach(function (sid) {
    const e = enrol[sid], d0 = dayNo_(e.att_start_date), st = (end[sid] || {}).status || '', a1 = pctV1(sid);
    if (!screenIds[sid]) Q(sid, 'S1_ENROL', e._row, '', 'No screening line in S0_SCREEN', '');
    if (d0 === null) Q(sid, 'S1_ENROL', e._row, '', 'Date ATT started missing', 'visit windows cannot be calculated');
    const lag = diff_(e.att_start_date, e.enrol_date);
    if (lag !== null && lag > CFG.WINDOWS.V1[2]) Q(sid, 'S1_ENROL', e._row, '', 'Enrolled more than 7 days after ATT started', lag + ' days');
    if (!e.dm_status) Q(sid, 'S1_ENROL', e._row, '', 'Diabetes status not recorded', a1 !== '' ? 'baseline HbA1c ' + a1 + '%' : '');
    else if (e.dm_status === 'N' && a1 !== '' && a1 < 6.5) Q(sid, 'S1_ENROL', e._row, '', 'New diabetes but baseline HbA1c below 6.5%', 'HbA1c ' + a1 + '%');
    else if (e.dm_status === '0' && a1 !== '' && a1 >= 6.5) Q(sid, 'S1_ENROL', e._row, '', 'Not diabetic but baseline HbA1c 6.5% or above', 'HbA1c ' + a1 + '%');
    if (d0 !== null && tday !== null && tday - d0 > CFG.WINDOWS.V1[2] && INACTIVE.indexOf(st) < 0) {
      if (!base[sid]) Q(sid, 'S2_BASELINE', '', 'V1', 'Baseline examination missing', '');
      if (!labs[sid + '|V1']) Q(sid, 'LABS', '', 'V1', 'Baseline laboratory results missing', '');
      if (!cxr[sid]) Q(sid, 'S3_CXR', '', '', 'Radiograph record missing', '');
      if (!phq[sid + '|V1'] && e.optout_questionnaires !== 'D') Q(sid, 'PHQ_GAD', '', 'V1', 'Baseline questionnaires missing', '');
    }
  });
  const used = ids.filter(idOk_).concat(Object.keys(destroyed).filter(idOk_)).map(function (s) { return +s.slice(CFG.ID_PREFIX.length); });
  if (used.length) {
    const top = Math.max.apply(null, used);
    const inHeld = function (k) {
      return (held || []).some(function (b) { return k >= +b.from && k <= +b.to && b.day && dayNo_(today) - dayNo_(b.day) <= CFG.BLOCK_GRACE_DAYS; });
    };
    for (let k = 1; k < top; k++) {
      const sid = idOf_(k);
      if (!enrol[sid] && !destroyed[sid] && !screenIds[sid] && !inHeld(k))   // a number used on a screening line (even screened out) is accounted for
        Q(sid, 'S1_ENROL', '', '', 'Study number skipped', 'explain the gap in the paper linking log');
    }
  }
  T('VISITS').forEach(function (r) {
    if (!r.study_id) return;
    const tag = function (c, d) { Q(r.study_id, 'VISITS', r._row, r.visit, c, d); };
    if (!r.attended) tag('Attendance not recorded', '');
    if (r.attended === 'Y') {
      if (!r.visit_date) tag('Visit date missing', '');
      if (hepAny_(r) === null) tag('Hepatotoxicity symptom enquiry incomplete', 'record all seven symptoms');
      if (r.visit === 'V3' && !r.conversion) tag('Sputum conversion missing', 'never leave blank at V3');
      if (r.visit === 'V5' && !r.outcome) tag('Treatment outcome missing', '');
      if ((r.visit === 'V3' || r.visit === 'V5') && !r.weight_kg) tag('Weight missing', 'needed for the TBscore');
    }
    if (r.conversion === 'Y' && ['S', '1', '2', '3'].indexOf(r.smear_result) >= 0) tag('Conversion Y but smear positive', '');
    if (r.conversion === 'N' && r.smear_result === 'N') tag('Conversion N but smear negative', '');
    const d = diff_((enrol[r.study_id] || {}).att_start_date, r.visit_date);
    if (d !== null && d < 0) tag('Visit date before ATT started', '');
  });
  T('LABS').forEach(function (r) {
    if (!r.study_id) return;
    const tag = function (c, d) { Q(r.study_id, 'LABS', r._row, r.visit, c, d); };
    if (!r.lab_status) tag('Laboratory status not recorded', '');
    if (/^U/.test(r.visit) && !r.symptomatic) tag('Symptom status missing for an unscheduled test', '');
    if (r.lab_status !== '1') return;
    const np = num_(r.neut_pct), lp = num_(r.lymph_pct);
    if (np !== null && lp !== null && np + lp > 100) tag('Neutrophil and lymphocyte percentages add to more than 100', '');
    const tlc = num_(r.tlc), abs = [r.neut_abs, r.lymph_abs, r.mono_abs].map(num_);
    if (tlc !== null && abs.every(function (x) { return x !== null; }) && abs[0] + abs[1] + abs[2] > tlc * 1.05) tag('Absolute counts exceed the total leucocyte count', '');
    if (num_(r.alt) !== null && num_(r.alt_uln) === null) tag('ALT upper limit of normal missing', 'needed for the liver injury definition');
    if (num_(r.ast) !== null && num_(r.ast_uln) === null) tag('AST upper limit of normal missing', 'needed to check AST against 3 times the upper limit');
    if (num_(r.alp) !== null && num_(r.alp_uln) === null) tag('ALP upper limit of normal missing', 'needed for the RUCAM injury pattern, CTCAE and Hy\'s law');
    if (num_(r.tbili) !== null && num_(r.bili_uln) === null) tag('Bilirubin upper limit of normal missing', 'needed for the liver injury definition');
    const aX = num_(r.alt) !== null && num_(r.alt_uln) > 0 ? num_(r.alt) / num_(r.alt_uln) : null, sX = num_(r.ast) !== null && num_(r.ast_uln) > 0 ? num_(r.ast) / num_(r.ast_uln) : null;
    if (r.visit !== 'V1' && ((aX !== null && aX > 3) || (sX !== null && sX > 3)) && !diliMet[r.study_id] && !hasEvent(r.study_id, 'E2'))
      tag('ALT or AST above 3 times the upper limit but no DILI event (E2) recorded', (aX !== null ? 'ALT ' + round_(aX, 1) + ' x ULN' : '') + (aX !== null && sX !== null ? ', ' : '') + (sX !== null ? 'AST ' + round_(sX, 1) + ' x ULN' : '') + ': decide whether this is a DILI event and record E2 if so');
    if (r.visit === 'V1') {
      if (!r.fasting) tag('Fasting status missing', '');
      if (num_(r.neut_abs) === null || num_(r.lymph_abs) === null) tag('Absolute neutrophil or lymphocyte count missing', 'primary outcome of Study 1');
      if (num_(r.hba1c) === null) tag('Baseline HbA1c missing', 'defines diabetes status');
      if (!r.hbsag || !r.anti_hcv || !r.hiv) tag('Baseline serology incomplete', '');
    }
  });
  Object.keys(diliMet).forEach(function (sid) {
    if (!hasEvent(sid, 'E2')) Q(sid, 'EVENTS', '', diliMet[sid], 'Liver injury definition met but no E2 event recorded', 'see DERIVED_LABS');
  });
  T('PHQ_GAD').forEach(function (r) {
    if (!r.study_id) return;
    const tag = function (c, d) { Q(r.study_id, 'PHQ_GAD', r._row, r.visit, c, d); };
    const items = [];
    for (let i = 1; i <= 9; i++) items.push(r['phq' + i]);
    for (let i = 1; i <= 7; i++) items.push(r['gad' + i]);
    const filled = items.filter(function (x) { return str_(x) !== ''; }).length;
    if (!r.declined) tag('Declined not recorded', 'Y or N');
    if (r.declined === 'Y' && filled > 0) tag('Declined but items entered', '');
    if (r.declined === 'N' && filled < 16) tag('Questionnaire incomplete', (16 - filled) + ' items blank');
    if (filled > 0 && (enrol[r.study_id] || {}).optout_questionnaires === 'D') tag('Questionnaire entered but the consent form says declined', '');
    if (r.declined !== 'Y' && num_(r.phq9) !== null && num_(r.phq9) > 0 && !hasEvent(r.study_id, 'E1')) tag('Item 9 above 0 but no E1 event recorded', '');
  });
  T('SPIRO').forEach(function (r) {
    if (!r.study_id) return;
    const tag = function (c, d) { Q(r.study_id, 'SPIRO', r._row, 'V5', c, d); };
    if (!r.spiro_status) tag('Spirometry status missing', '');
    if (r.spiro_status !== 'Y') return;
    const f1 = num_(r.fev1_l), fv = num_(r.fvc_l), rp = num_(r.fev1_fvc_pct), na = num_(r.n_acceptable);
    if (f1 === null || fv === null) tag('FEV1 or FVC missing', '');
    if (f1 !== null && fv !== null && f1 > fv) tag('FEV1 greater than FVC', '');
    if (f1 !== null && fv !== null && rp !== null && Math.abs(100 * f1 / fv - rp) > 2) tag('FEV1/FVC does not match FEV1 and FVC', 'calculated ' + round_(100 * f1 / fv, 1) + '%');
    if (na !== null && na < 3) tag('Fewer than 3 acceptable manoeuvres', 'result not reportable');
    const v5 = visits[r.study_id + '|V5'];
    if (!v5 || v5.smear_result !== 'N') tag('Spirometry done but the Visit 5 smear is not recorded as negative', '');
    if ((enrol[r.study_id] || {}).optout_spirometry === 'D') tag('Spirometry done but the consent form says declined', '');
  });
  T('S3_CXR').forEach(function (r) {
    if (!r.study_id) return;
    const both = timika_(r.r1_pct, r.r1_cavity) !== '' && timika_(r.r2_pct, r.r2_cavity) !== '';
    if (both && !r.resolution) Q(r.study_id, 'S3_CXR', r._row, '', 'Reader scores need resolution (PI)', '');
    [1, 2].forEach(function (n) {                              // catches a reader who typed in their file directly, past the phone's checks
      const cv = code_(r['r' + n + '_cavity']), nc = num_(r['r' + n + '_ncav']);
      if ((cv === 'N' && nc !== null && nc !== 0) || (cv === 'Y' && (nc === null || nc < 1)))
        Q(r.study_id, 'S3_CXR', r._row, '', 'Reader ' + n + ' cavity count does not match the cavity answer', 'cavity ' + cv + ', count ' + (nc === null ? 'blank' : nc) + ': ask reader ' + n + ' to correct their file');
    });
    if ((r.resolution === 'T' || r.resolution === 'D') && num_(r.final_override) === null) Q(r.study_id, 'S3_CXR', r._row, '', 'Final Timika score missing (PI)', '');
    if (both && r.r1_cavity !== r.r2_cavity && !r.cavity_final) Q(r.study_id, 'S3_CXR', r._row, '', 'Readers disagree on cavity: final cavity needed (PI)', '');
  });
  events.forEach(function (r) {
    if (!r.study_id) return;
    const tag = function (c, d) { Q(r.study_id, 'EVENTS', r._row, '', c, d); };
    if (!r.event_type) tag('Event type missing', '');
    if (r.serious === 'Y' && !r.irb_reported_date) {
      const d = diff_(r.detected_date, today);
      tag('Serious event not yet reported to the IRB', d === null ? 'report within 7 days' : 'detected ' + d + ' days ago; report within 7 days');
    }
    if (r.event_type === 'E1' && r.e1_risk_assessed !== 'Y') tag('Same-day risk assessment not recorded', '');
    if (r.event_type === 'E2' && r.team_informed !== 'Y') tag('Treating team not recorded as informed', '');
    if (r.event_type === 'E2' && rucamTotal_(r) === '') tag('RUCAM: choose the injury pattern and answer every item', 'one RUCAM score per event');
    if (r.event_type === 'E4' && !r.e4_choice) tag('Withdrawal data choice missing', '');
  });
  T('END_STUDY').forEach(function (r) {
    if (r.study_id && r.status === 'W' && !r.retention) Q(r.study_id, 'END_STUDY', r._row, '', 'Withdrawal data choice missing', '');
  });
  // ---- queries 3: cross-form, protocol and plausibility checks (SCDM edit-check categories; WHO 2013 TB outcome definitions;
  // ADA diagnostic thresholds; manual Parts 3 and 4). Wording is neutral: each asks for a check, never for a particular answer.
  const gone = function (sid) { return destroyed[sid]; };
  const labsOf = {}; T('LABS').forEach(function (r) { if (r.study_id) (labsOf[r.study_id] = labsOf[r.study_id] || []).push(r); });
  const has = function (v) { return str_(v) !== ''; };
  const winTxt = function (v) { const w = CFG.WINDOWS[v]; return w ? 'day ' + w[1] + ' to ' + w[2] : ''; };
  const outWin = function (sid, v, date) {                       // true when a scheduled visit date falls outside its window
    const d = diff_((enrol[sid] || {}).att_start_date, date), w = CFG.WINDOWS[v];
    return d !== null && w ? (d < w[1] || d > w[2] ? d : null) : null;
  };
  // screening against enrolment
  screen.forEach(function (r) {
    const e = enrol[r.study_id]; if (!e || gone(r.study_id)) return;
    const tag = function (c, d) { Q(r.study_id, 'S1_ENROL', e._row, '', c, d); };
    if (num_(r.age) !== null && num_(e.age_years) !== null && Math.abs(num_(r.age) - num_(e.age_years)) > 1) tag('Age differs between screening and enrolment', 'screening ' + r.age + ', enrolment ' + e.age_years);
    if (has(r.sex) && has(e.sex) && r.sex !== e.sex) tag('Sex differs between screening and enrolment', 'screening ' + r.sex + ', enrolment ' + e.sex);
    if (has(r.smear_grade) && has(e.smear_grade) && r.smear_grade !== e.smear_grade) tag('Smear grade differs between screening and enrolment', 'screening ' + r.smear_grade + ', enrolment ' + e.smear_grade);
  });
  ids.forEach(function (sid) {
    if (gone(sid)) return;
    const e = enrol[sid], tag = function (c, d) { Q(sid, 'S1_ENROL', e._row, '', c, d); };
    const miss = ['age_years', 'sex', 'smear_grade', 'regimen', 'smoking', 'alcohol', 'htn'].filter(function (k) { return !has(e[k]); });
    if (miss.length) tag('Enrolment items missing', miss.join(', '));
    if (e.dm_status === 'K' && (!has(e.dm_drugs) || !has(e.dm_years))) tag('Known diabetes: duration or drugs missing', '');
    if (e.dm_status === '0' && has(e.dm_drugs) && e.dm_drugs !== '0') tag('Not diabetic but diabetes drugs recorded', 'drugs ' + e.dm_drugs);
    if (e.smoking === '0' && num_(e.pack_years) !== null && num_(e.pack_years) > 0) tag('Never smoker but pack-years recorded', e.pack_years + ' pack-years');
    const l1 = labs[sid + '|V1'];
    if (l1 && e.dm_status === '0') {
      const g = num_(l1.fpg), u = code_(l1.glucose_unit);
      if (g !== null && ((u === 'M' && g >= 126) || (u === 'L' && g >= 7.0))) tag('Not diabetic but baseline fasting glucose in the diabetic range', 'FPG ' + g + (u === 'M' ? ' mg/dL' : ' mmol/L') + (l1.fasting === 'N' ? ' (sample not fasting)' : '') + '; ADA threshold 126 mg/dL (7.0 mmol/L)');
    }
    if (l1) {
      const lt = function (c, d) { Q(sid, 'LABS', l1._row, 'V1', c, d); };
      if (l1.hiv === 'R') lt('HIV reactive at baseline', 'confirm it was not known before enrolment (exclusion 2) and inform the treating team');
      if (l1.hbsag === 'P' || l1.anti_hcv === 'P') lt('Hepatitis B or C marker positive at baseline', 'confirm there is no chronic liver disease (exclusion 5); RUCAM item 5 needs this');
      const a = ratio_(l1.alt, l1.alt_uln), s2 = ratio_(l1.ast, l1.ast_uln), b = ratio_(l1.tbili, l1.bili_uln);
      if ((a !== '' && a > 3) || (s2 !== '' && s2 > 3) || (b !== '' && b > 2)) lt('Raised liver tests before ATT', (a !== '' ? 'ALT ' + a + ' x ULN ' : '') + (s2 !== '' ? 'AST ' + s2 + ' x ULN ' : '') + (b !== '' ? 'bilirubin ' + b + ' x ULN' : '') + ': confirm there is no chronic liver disease (exclusion 5); this is the CTCAE baseline');
    }
    // baseline examination
    const b0 = base[sid];
    if (b0) {
      const bt = function (c, d) { Q(sid, 'S2_BASELINE', b0._row, 'V1', c, d); };
      const ow = outWin(sid, 'V1', b0.exam_date); if (ow !== null) bt('Baseline examination outside the Visit 1 window', 'day ' + ow + '; window ' + winTxt('V1'));
      const bm = bmi_(b0.weight_kg, b0.height_cm); if (bm !== '' && (bm < 12 || bm > 60)) bt('BMI outside 12 to 60', 'BMI ' + bm + ': check height and weight');
    }
    // visits: order, windows, plausibility of change, labs and questionnaires that should exist
    const order = ['V2', 'V3', 'V4', 'V5'];
    let prevDate = b0 ? b0.exam_date : '', prevV = 'V1', prev = b0 ? { weight_kg: b0.weight_kg, waist_cm: b0.waist_cm, muac_mm: b0.muac_mm } : null;
    order.forEach(function (v) {
      const r = visits[sid + '|' + v]; if (!r || r.attended !== 'Y') return;
      const vt = function (c, d) { Q(sid, 'VISITS', r._row, v, c, d); };
      const ow = outWin(sid, v, r.visit_date); if (ow !== null && ow >= 0) vt('Visit outside its window', 'day ' + ow + '; window ' + winTxt(v));
      const gap = diff_(prevDate, r.visit_date); if (gap !== null && gap < 0) vt('Visit dated before the previous visit', prevV + ' ' + prevDate + ', ' + v + ' ' + r.visit_date);
      if (has(r.visit_date)) { prevDate = r.visit_date; prevV = v; }
      if (prev && has(r.weight_kg)) {
        const w0 = num_(prev.weight_kg), w1 = num_(r.weight_kg), c0 = num_(prev.waist_cm), c1 = num_(r.waist_cm), m0 = num_(prev.muac_mm), m1 = num_(r.muac_mm);
        if (w0 && w1 && Math.abs(w1 - w0) / w0 > 0.2) vt('Weight changed by more than 20% since the last measurement', w0 + ' to ' + w1 + ' kg: check the value');
        if (c0 !== null && c1 !== null && Math.abs(c1 - c0) > 20) vt('Waist changed by more than 20 cm since the last measurement', c0 + ' to ' + c1 + ' cm: check the value');
        if (m0 !== null && m1 !== null && Math.abs(m1 - m0) > 50) vt('MUAC changed by more than 50 mm since the last measurement', m0 + ' to ' + m1 + ' mm: check the value');
      }
      if (has(r.weight_kg)) prev = { weight_kg: r.weight_kg, waist_cm: r.waist_cm, muac_mm: r.muac_mm };
      const v3s = (visits[sid + '|V3'] || {}).smear_result;
      if (smearDue_(v, v3s) && has(r.smear_result) && r.smear_result !== 'X' && !has(r.smear_date)) vt('Smear result without a smear date', '');
      if (v === 'V4' && smearDue_(v, v3s) && !has(r.smear_result)) vt('V3 smear not negative: repeat the smear at V4', 'repeat the smear at each visit until a negative smear is documented');
      if (has(r.smear_date) && !has(r.smear_result)) vt('Smear date without a result', '');
      // liver symptoms need liver tests the same day (manual 4.3); the next day is accepted
      if (hepAny_(r) === true) {
        const ok = (labsOf[sid] || []).some(function (l) { const g2 = diff_(r.visit_date, l.sample_date); return l.lab_status === '1' && num_(l.alt) !== null && g2 !== null && g2 >= 0 && g2 <= 1; });
        if (!ok) Q(sid, 'LABS', '', v, 'Liver symptoms recorded but no liver test result on the same or the next day', 'manual 4.3: draw liver tests the same day; enter them as this visit or as an unscheduled test');
      }
      const dv = diff_(r.visit_date, today);
      if (!labs[sid + '|' + v] && dv !== null && dv > 7) Q(sid, 'LABS', '', v, 'No laboratory row for this visit', 'visit was ' + dv + ' days ago; enter the results, or the row with lab status not done');
      if (v === 'V5' && !phq[sid + '|V5'] && e.optout_questionnaires !== 'D' && dv !== null && dv > 7) Q(sid, 'PHQ_GAD', '', 'V5', 'Visit 5 questionnaires missing', '');
      // treatment outcome against the smear results (WHO 2013 definitions)
      if (v === 'V5' && has(r.outcome)) {
        const v3 = visits[sid + '|V3'] || {};
        if (r.outcome === 'C' && (r.smear_result !== 'N' || v3.smear_result !== 'N')) vt('Outcome cured but the smears do not show it', 'WHO: cured needs a negative smear in the last month and on at least one earlier occasion; V3 ' + (v3.smear_result || 'blank') + ', V5 ' + (r.smear_result || 'blank'));
        if (r.outcome === 'T' && r.smear_result === 'N' && v3.smear_result === 'N') vt('Treatment completed, but V3 and V5 smears are negative', 'WHO: this meets cured; check the outcome');
        if (r.outcome === 'F' && ['S', '1', '2', '3'].indexOf(r.smear_result) < 0) vt('Outcome failed but the V5 smear is not positive', 'WHO: failed means smear or culture positive at month 5 or later; record the culture or check the outcome');
        if (['S', '1', '2', '3'].indexOf(r.smear_result) >= 0 && (r.outcome === 'C' || r.outcome === 'T')) vt('V5 smear positive but outcome is cured or completed', 'WHO: a positive smear at month 5 or later is treatment failure');
        const want = { D: 'D', L: 'L', X: 'X', C: 'C', T: 'C' }[r.outcome], st = (end[sid] || {}).status;
        if (want && st && st !== want) vt('Treatment outcome does not match the end-of-study status', 'outcome ' + r.outcome + ', end status ' + st);
      }
    });
    // end of study
    const en = end[sid];
    if (en && en.status) {
      const et = function (c, d) { Q(sid, 'END_STUDY', en._row, '', c, d); };
      if (!has(en.status_date)) et('End-of-study date missing', '');
      if (en.status === 'C') { const v5 = visits[sid + '|V5']; if (!v5 || v5.attended !== 'Y') Q(sid, 'VISITS', v5 ? v5._row : '', 'V5', 'Completed, but Visit 5 is not recorded as attended', 'the fix is in Visit 5 (attended), or change the end-of-study status'); }
      if (en.status !== 'C' && has(en.status_date)) {
        const later = order.map(function (v) { return visits[sid + '|' + v]; }).filter(function (r) { return r && diff_(en.status_date, r.visit_date) > 0; });
        if (later.length) et('Visits recorded after the end-of-study date', later.map(function (r) { return r.visit + ' ' + r.visit_date; }).join(', '));
      }
      if (en.status === 'W' && !hasEvent(sid, 'E4')) Q(sid, 'EVENTS', '', '', 'Withdrawn but no E4 event recorded', 'add the E4 event, or change the end-of-study status');
      if (en.status === 'D' && !events.some(function (x) { return x.study_id === sid && x.outcome === 'D'; }) && !(visits[sid + '|V5'] || {}).outcome) { const v5d = visits[sid + '|V5']; Q(sid, 'VISITS', v5d ? v5d._row : '', 'V5', 'Died: record the event or the V5 outcome', 'enter outcome D at Visit 5, or record the event with outcome died'); }
    } else if (hasEvent(sid, 'E4')) Q(sid, 'END_STUDY', '', '', 'E4 withdrawal recorded but no end-of-study row', 'add status W with the data choice');
  });
  // laboratory rows
  const REQ = { V1: ['tlc', 'plt', 'alt', 'ast', 'tbili', 'tg', 'hdl'], V2: ['alt', 'ast', 'tbili'],
    V3: ['tlc', 'neut_abs', 'lymph_abs', 'plt', 'alt', 'ast', 'tbili'], V4: ['hba1c', 'tlc', 'neut_abs', 'lymph_abs', 'alt', 'ast', 'tbili'], V5: ['tlc', 'neut_abs', 'lymph_abs', 'plt', 'alt', 'ast', 'tbili'] };
  const RESULTS = ['hb', 'tlc', 'neut_abs', 'lymph_abs', 'mono_abs', 'plt', 'hba1c', 'fpg', 'tg', 'hdl', 'tc', 'ldl', 'alt', 'ast', 'alp', 'tbili', 'albumin', 'tprotein'];
  T('LABS').forEach(function (r) {
    if (!r.study_id || gone(r.study_id)) return;
    const tag = function (c, d) { Q(r.study_id, 'LABS', r._row, r.visit, c, d); };
    const n = RESULTS.filter(function (k) { return num_(r[k]) !== null; }).length;
    if (r.lab_status && r.lab_status !== '1' && n) tag('Results entered although the laboratory status is not done, declined or rejected', n + ' value(s); correct the status or clear the values');
    if (r.lab_status === '1' && !n) tag('Laboratory status done but no results entered', '');
    if (r.lab_status !== '1') return;
    const ow = /^U/.test(r.visit) ? null : outWin(r.study_id, r.visit, r.sample_date);
    if (ow !== null) tag('Sample outside the visit window', 'day ' + ow + '; window ' + winTxt(r.visit));
    const miss = (REQ[r.visit] || []).filter(function (k) { return num_(r[k]) === null; });
    if (miss.length && n) tag('Tests expected at this visit are missing', miss.join(', ') + ' (visit checklist)');
    const tlc = num_(r.tlc), sumAbs = ['neut_abs', 'lymph_abs', 'mono_abs'].reduce(function (m, k) { return m + (num_(r[k]) || 0); }, 0);
    if (tlc && sumAbs <= tlc * 1.05) [['neut', 'Neutrophil'], ['lymph', 'Lymphocyte']].forEach(function (x) {   // not repeated when the counts already exceed the total
      const ab = num_(r[x[0] + '_abs']), pc = num_(r[x[0] + '_pct']);
      if (tlc && ab !== null && pc !== null && Math.abs(100 * ab / tlc - pc) > 10) tag(x[1] + ' percentage does not match the count', 'count gives ' + round_(100 * ab / tlc, 0) + '%, entered ' + pc + '%');
    });
    const tc = num_(r.tc), hd = num_(r.hdl), ld = num_(r.ldl);
    if (tc !== null && ((hd !== null && hd >= tc) || (ld !== null && ld >= tc))) tag('HDL or LDL not below total cholesterol', 'check the lipid values and unit');
  });
  // questionnaires
  T('PHQ_GAD').forEach(function (r) {
    if (!r.study_id || gone(r.study_id)) return;
    const tag = function (c, d) { Q(r.study_id, 'PHQ_GAD', r._row, r.visit, c, d); };
    const i9 = num_(r.phq9);
    if (has(r.e1_form_no) && i9 !== null && i9 === 0) tag('E1 form number entered but item 9 is 0', 'the E1 form belongs to the visit where item 9 was above 0');
    if (r.declined !== 'Y' && i9 !== null && i9 > 0 && !has(r.e1_form_no)) tag('Item 9 above 0 but no E1 form number', '');
    const ow = outWin(r.study_id, r.visit, r.interview_date); if (ow !== null) tag('Interview outside the visit window', 'day ' + ow + '; window ' + winTxt(r.visit));
  });
  // spirometry (pattern is taken as printed: ATS/ERS 2022 use the lower limit of normal, so no fixed-ratio check is made)
  T('SPIRO').forEach(function (r) {
    if (!r.study_id || gone(r.study_id) || r.spiro_status !== 'Y') return;
    const tag = function (c, d) { Q(r.study_id, 'SPIRO', r._row, 'V5', c, d); };
    if (!has(r.test_date)) tag('Spirometry test date missing', '');
    else { const ow = outWin(r.study_id, 'V5', r.test_date); if (ow !== null) tag('Spirometry outside the Visit 5 window', 'day ' + ow + '; window ' + winTxt('V5')); }
  });
  // radiograph reads still pending two weeks after the film
  T('S3_CXR').forEach(function (r) {
    if (!r.study_id || gone(r.study_id)) return;
    const two = timika_(r.r1_pct, r.r1_cavity) !== '' && timika_(r.r2_pct, r.r2_cavity) !== '', age = diff_(r.cxr_date, today);
    if (!two && age !== null && age > 14) Q(r.study_id, 'S3_CXR', r._row, '', 'Radiograph not yet scored by both readers', 'film taken ' + age + ' days ago');
  });
  // events
  events.forEach(function (r) {
    if (!r.study_id || gone(r.study_id)) return;
    const tag = function (c, d) { Q(r.study_id, 'EVENTS', r._row, '', c, d); };
    if (diff_(r.onset_date, r.detected_date) < 0) tag('Detected before the onset date', '');
    if (diff_(r.detected_date, r.team_informed_date) < 0) tag('Treating team informed before the event was detected', '');
    if (diff_(r.detected_date, r.irb_reported_date) < 0) tag('IRB report dated before the event was detected', '');
    if (r.team_informed === 'Y' && !has(r.team_informed_date)) tag('Date the treating team was informed missing', '');
    if (r.event_type === 'E1' && !T('PHQ_GAD').some(function (p) { return p.study_id === r.study_id && p.declined !== 'Y' && num_(p.phq9) > 0; })) tag('E1 recorded but no questionnaire has item 9 above 0', '');
    if (r.event_type === 'E2') {
      const ls = labsOf[r.study_id] || [], x3 = ls.some(function (l) { const a = ratio_(l.alt, l.alt_uln), s2 = ratio_(l.ast, l.ast_uln); return l.visit !== 'V1' && ((a !== '' && a >= 3) || (s2 !== '' && s2 >= 3)); });
      if (!x3) tag('E2 recorded but no on-treatment ALT or AST reaches 3 times the upper limit', 'enter the liver test that triggered the event, or check it against the definition in manual 4.2');
      if (r.e2_hys_law === 'Y' && !ls.some(function (l) { const a = ratio_(l.alt, l.alt_uln), s2 = ratio_(l.ast, l.ast_uln), b = ratio_(l.tbili, l.bili_uln); return ((a !== '' && a > 3) || (s2 !== '' && s2 > 3)) && b !== '' && b > 2; }))
        tag("Hy's law Y but no single sample has ALT or AST above 3 and bilirubin above 2 times the upper limit", '');
    }
    if (r.outcome === 'D' && (end[r.study_id] || {}).status !== 'D') tag('Event outcome died but end-of-study status is not died', '');
  });
  // ---- queries 4: end-of-study review. Once an end-of-study status is entered, every form, visit and field the participant
  // should have by that point is checked, and the open queries are counted, so the record can be closed clean.
  // A visit is expected when its window closed on or before the end-of-study date (all five for status C).
  const already = function (sid, tab, visit, re) { return out.queries.some(function (q) { return q[0] === sid && q[1] === tab && (visit === null || q[3] === visit) && re.test(q[4]); }); };
  const blanks = function (r, keys) { return keys.filter(function (k) { return !has(r[k]); }); };
  const S2_KEYS = SCHEMA.filter(function (t) { return t.tab === 'S2_BASELINE'; })[0].cols.map(function (c) { return c.key; }).filter(function (k) { return k !== 'study_id'; });
  const reviewed = [];
  ids.forEach(function (sid) {
    const en = end[sid];
    if (!en || !en.status || gone(sid)) return;
    reviewed.push(sid);
    const e = enrol[sid], RV = 'End-of-study review: ';
    const R = function (tab, row, visit, c, d) { Q(sid, tab, row, visit, RV + c, d); };
    const d0 = dayNo_(e.att_start_date), dEnd = en.status === 'C' ? null : dayNo_(en.status_date);
    const expected = ['V1', 'V2', 'V3', 'V4', 'V5'].filter(function (v) { return en.status === 'C' || (d0 !== null && dEnd !== null && d0 + CFG.WINDOWS[v][2] <= dEnd); });
    // enrolment: every item, with the conditional ones only where they apply
    let k1 = ['enrol_date', 'att_start_date', 'age_years', 'sex', 'residence', 'education', 'smoking', 'alcohol', 'dm_status', 'htn', 'regimen', 'smear_grade', 'genexpert', 'optout_questionnaires', 'optout_spirometry', 'entered_by'];
    if (e.smoking === '1' || e.smoking === '2') k1.push('pack_years');
    if (e.dm_status === 'K') k1 = k1.concat(['dm_years', 'dm_drugs']);
    if (e.genexpert === 'D') k1.push('rif_res');
    const COVERED = ['age_years', 'sex', 'smear_grade', 'regimen', 'smoking', 'alcohol', 'htn', 'att_start_date', 'dm_status', 'dm_years', 'dm_drugs'];   // already named by the queries above
    const m1 = blanks(e, k1).filter(function (k) { return COVERED.indexOf(k) < 0; });
    if (m1.length) R('S1_ENROL', e._row, '', 'enrolment fields blank', m1.join(', '));
    // baseline examination and radiograph
    const b0 = base[sid];
    if (!b0) { if (!already(sid, 'S2_BASELINE', 'V1', /missing/)) R('S2_BASELINE', '', 'V1', 'baseline examination missing', ''); }
    else { const m2 = blanks(b0, S2_KEYS); if (m2.length) R('S2_BASELINE', b0._row, 'V1', 'baseline fields blank', m2.join(', ')); }
    const c = cxr[sid];
    if (!c) { if (!already(sid, 'S3_CXR', null, /missing/)) R('S3_CXR', '', '', 'radiograph record missing', ''); }
    else {
      const t1 = timika_(c.r1_pct, c.r1_cavity), t2 = timika_(c.r2_pct, c.r2_cavity);
      const final = (c.resolution === 'M' && t1 !== '' && t2 !== '') || ((c.resolution === 'T' || c.resolution === 'D') && num_(c.final_override) !== null);
      if (!final && !already(sid, 'S3_CXR', null, /resolution|Final Timika|not yet scored/)) R('S3_CXR', c._row, '', 'no final Timika score', 'both reads and the resolution are needed');
      if (!c.cavity_final && !(c.r1_cavity && c.r1_cavity === c.r2_cavity) && !already(sid, 'S3_CXR', null, /cavity/)) R('S3_CXR', c._row, '', 'no final cavity result', '');
    }
    // visits and their laboratory rows
    expected.forEach(function (v) {
      const l = labs[sid + '|' + v];
      if (!l) { if (!already(sid, 'LABS', v, /missing|No laboratory row/) && !already(sid, 'VISITS', v, /No laboratory row/)) R('LABS', '', v, 'laboratory row missing', 'enter the results, or the row with lab status not done'); }
      if (v === 'V1') return;
      const r = visits[sid + '|' + v];
      if (!r) { if (!already(sid, 'VISITS', v, /Visit 5 is not recorded/)) R('VISITS', '', v, 'visit not recorded', 'record it, with attended N if it was missed'); return; }
      if (r.attended === 'N') { if (en.status === 'C' && !already(sid, 'VISITS', v, /Visit 5 is not recorded/)) R('VISITS', r._row, v, 'status completed but this visit was not attended', 'check the end-of-study status'); return; }
      if (r.attended !== 'Y') return;
      let kv = ['treatment', 'adherence', 'entered_by'];
      if (v === 'V3' || v === 'V5') kv = kv.concat(['waist_cm', 'muac_mm', 'temp_c', 'pulse_min', 'pallor', 'auscultation', 'tb_cough', 'tb_haemoptysis', 'tb_dyspnoea', 'tb_chest_pain', 'tb_night_sweats', 'smear_result']);
      if ((v === 'V3' || v === 'V5') && r.smear_result !== 'X') kv.push('smear_date');
      if (v === 'V4') kv.push('dm_referred');
      if (v === 'V4' && smearDue_(v, (visits[sid + '|V3'] || {}).smear_result) && !already(sid, 'VISITS', v, /repeat the smear at V4/)) { kv.push('smear_result'); if (r.smear_result !== 'X') kv.push('smear_date'); }
      const mv = blanks(r, kv).filter(function (k) { return !(k === 'smear_date' && already(sid, 'VISITS', v, /Smear result without/)); });
      if (mv.length) R('VISITS', r._row, v, 'visit fields blank', mv.join(', '));
    });
    // questionnaires at V1 and V5
    if (e.optout_questionnaires !== 'D') ['V1', 'V5'].forEach(function (v) {
      if (expected.indexOf(v) < 0) return;
      const p = phq[sid + '|' + v];
      if (!p) { if (!already(sid, 'PHQ_GAD', v, /questionnaires missing/)) R('PHQ_GAD', '', v, 'questionnaire row missing', 'enter it, or the row with declined Y'); return; }
      const mp = blanks(p, ['interview_date', 'interviewer', 'declined']);
      if (mp.length) R('PHQ_GAD', p._row, v, 'questionnaire fields blank', mp.join(', '));
    });
    // spirometry at V5: expected when completed, not opted out and the V5 smear is negative
    if (en.status === 'C' && e.optout_spirometry !== 'D' && (visits[sid + '|V5'] || {}).smear_result === 'N') {
      const sp = T('SPIRO').filter(function (x) { return x.study_id === sid; })[0];
      if (!sp) R('SPIRO', '', 'V5', 'spirometry row missing', 'enter the result, or status not done, declined or contraindicated');
      else if (sp.spiro_status === 'Y') {
        const ms = blanks(sp, ['operator', 'calibrated_today', 'n_acceptable', 'fev1_fvc_pct', 'fev1_pct_pred', 'fvc_pct_pred', 'pattern', 'referred', 'entered_by']);
        if (ms.length) R('SPIRO', sp._row, 'V5', 'spirometry fields blank', ms.join(', '));
      }
    }
    // events: every event closed with its own fields complete
    events.filter(function (x) { return x.study_id === sid; }).forEach(function (x) {
      let ke = ['event_type', 'onset_date', 'detected_date', 'team_informed', 'serious', 'outcome', 'entered_by'];
      if (x.event_type === 'E1') ke = ke.concat(['e1_risk_assessed', 'e1_psych_referral']);
      if (x.event_type === 'E2') ke = ke.concat(['e2_ctcae', 'e2_hys_law']);
      if (x.event_type === 'E3') ke.push('e3_procedure');
      const me = blanks(x, ke);
      if (me.length) R('EVENTS', x._row, '', 'event ' + (x.event_no || '') + ' fields blank', me.join(', '));
      if (x.outcome === 'O') R('EVENTS', x._row, '', 'event ' + (x.event_no || '') + ' still ongoing', 'record the outcome at the end of follow-up: resolved, resolved with sequelae, or died');
    });
    if (!has(en.recorded_by)) R('END_STUDY', en._row, '', 'recorded by blank', '');
  });
  // the closing line: how many other queries are still open for each reviewed participant
  reviewed.forEach(function (sid) {
    const open = out.queries.filter(function (q) { return q[0] === sid && q[4].indexOf('End-of-study review') !== 0; });
    if (open.length) Q(sid, 'END_STUDY', end[sid]._row, '', 'End-of-study review: ' + open.length + ' other open quer' + (open.length === 1 ? 'y' : 'ies'), 'resolve before the record is closed: ' + open.map(function (q) { return q[1] + (q[3] ? ' ' + q[3] : ''); }).filter(function (t, i, a) { return a.indexOf(t) === i; }).join(', '));
  });
  const byRow = {};
  SCHEMA.forEach(function (t) { const m = byRow[t.tab] = {}; T(t.tab).forEach(function (r) { if (r._row) m[r._row] = r; }); });
  out.queries.forEach(function (q) {
    q[6] = queryField_(q[1], q[4], q[5]);
    const rec = q[2] ? (byRow[q[1]] || {})[q[2]] : null;
    q[7] = rec ? str_(rec.event_no || rec.screen_no || '') : '';
  });
  out.queries.sort(function (a, b) {
    const x = a[0] + '|' + a[1] + '|' + ('00000' + a[2]).slice(-5), y = b[0] + '|' + b[1] + '|' + ('00000' + b[2]).slice(-5);
    return x < y ? -1 : x > y ? 1 : 0;
  });

  // ---- summary
  const S = function (k, v) { out.summary.push([k, String(v)]); };
  const cnt = function (rows, f) { return rows.filter(f).length; };
  const dmK = cnt(ids, function (s) { return enrol[s].dm_status === 'K'; }), dmN = cnt(ids, function (s) { return enrol[s].dm_status === 'N'; });
  const dm0 = cnt(ids, function (s) { return enrol[s].dm_status === '0'; }), classified = dmK + dmN + dm0;
  S('Screened', screen.length);
  S('Eligible', cnt(screen, function (r) { return r.eligible === 'Y'; }));
  S('Enrolled', ids.length);
  S('Diabetic at enrolment, known (K)', dmK);
  S('Diabetic at enrolment, new (N)', dmN);
  S('Not diabetic (0)', dm0);
  S('Diabetes status not yet recorded', ids.length - classified);
  S('Proportion diabetic among those classified', classified ? round_(100 * (dmK + dmN) / classified, 1) + '%' : '');
  ['V2', 'V3', 'V4', 'V5'].forEach(function (v) { S('Visit ' + v + ' attended', cnt(T('VISITS'), function (r) { return r.visit === v && r.attended === 'Y'; })); });
  [['C', 'Completed all visits'], ['W', 'Withdrawn'], ['L', 'Lost to follow-up'], ['X', 'Transferred out'], ['D', 'Died']]
    .forEach(function (p) { S(p[1], cnt(T('END_STUDY'), function (r) { return r.status === p[0]; })); });
  S('Visits overdue', cnt(out.schedule, function (r) { return r[5] === 'overdue'; }));
  S('Visits due now', cnt(out.schedule, function (r) { return r[5] === 'due now'; }));
  S('Open data queries', out.queries.length);
  S('Current alert conditions: E1 / E2 / E2 to check', cnt(out.alerts, function (a) { return a.type === 'E1'; }) + ' / ' +
    cnt(out.alerts, function (a) { return a.type === 'E2'; }) + ' / ' + cnt(out.alerts, function (a) { return a.type === 'E2-check'; }));
  const nlr = out.labs.filter(function (r) { return r[1] === 'V1' && r[5] !== ''; }).map(function (r) { return r[5]; });
  S('Baseline NLR, all participants pooled (six-month sample size check): n', nlr.length);
  if (nlr.length > 1) {
    const mean = nlr.reduce(function (a, b) { return a + b; }, 0) / nlr.length;
    const sd = Math.sqrt(nlr.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (nlr.length - 1));
    S('Baseline NLR, pooled: mean', round_(mean, 2));
    S('Baseline NLR, pooled: SD', round_(sd, 2));
  }
  return out;
}

// ---------------------------------------------------------------- validation rules and help text
function validationFormula_(c, L, def) {
  const ref = L + '2', keys = def.cols.map(function (x) { return x.key; });
  const letter = function (key) { const i = keys.indexOf(key); if (i < 0) throw new Error('No column ' + key + ' in ' + def.tab); return colLetter_(i + 1); };
  const idForm = 'AND(REGEXMATCH(TO_TEXT(' + ref + '),"^' + CFG.ID_PREFIX + '[0-9]{3}$"),VALUE(RIGHT(' + ref + ',3))>=1,VALUE(RIGHT(' + ref + ',3))<=' + CFG.ID_MAX + ')';
  const enrolled = 'COUNTIF(INDIRECT("S1_ENROL!A2:A"),' + ref + ')=1';
  const unique = 'COUNTIF(' + L + '$2:' + L + ',' + ref + ')=1';
  const pairUnique = function () {
    const P = letter(c.pair);
    return 'OR($' + P + '2="",COUNTIFS(' + L + '$2:' + L + ',' + ref + ',$' + P + '$2:$' + P + ',$' + P + '2)=1)';
  };
  switch (c.type) {
    case 'int': return '=AND(ISNUMBER(' + ref + '),' + ref + '=INT(' + ref + '),' + ref + '>=' + c.min + ',' + ref + '<=' + c.max + ')';
    case 'uniqueint': return '=AND(ISNUMBER(' + ref + '),' + ref + '=INT(' + ref + '),' + ref + '>=' + c.min + ',' + ref + '<=' + c.max + ',' + unique + ')';
    case 'time': return '=AND(ISNUMBER(' + ref + '),' + ref + '>=0,' + ref + '<1)';
    case 'text': return '=LEN(' + ref + ')<=' + c.max;
    case 'regex': return '=REGEXMATCH(TO_TEXT(' + ref + '),"' + c.pattern + '")';
    case 'sidnew': return '=AND(' + idForm + ',' + unique + ')';
    case 'sid': return '=AND(' + enrolled + ',' + unique + ')';
    case 'sidl': return c.pair ? '=AND(' + enrolled + ',' + pairUnique() + ')' : '=' + enrolled;
    case 'rid': return '=AND(' + idForm + ',' + pairUnique() + ')';
    case 'pairlist': return '=AND(OR(' + c.values.map(function (v) { return 'EXACT(' + ref + ',"' + v + '")'; }).join(',') + '),' + pairUnique() + ')';
    case 'unitnum': {
      const U = letter(c.unit);
      return '=AND(ISNUMBER(' + ref + '),OR(' + Object.keys(c.ranges).map(function (k) {
        return 'AND($' + U + '2="' + k + '",' + ref + '>=' + c.ranges[k][0] + ',' + ref + '<=' + c.ranges[k][1] + ')';
      }).join(',') + '))';
    }
  }
  return null;
}
function helpText_(c) {
  if (c.hint) return c.hint;
  if (c.codes) return c.codes.map(function (p) { return p[0] + (p[1] ? ' = ' + p[1] : ''); }).join('; ');
  switch (c.type) {
    case 'num': return 'Number from ' + c.min + ' to ' + c.max;
    case 'int': return 'Whole number from ' + c.min + ' to ' + c.max;
    case 'uniqueint': return 'Whole number, not used before in this tab';
    case 'date': return 'Date: pick it from the calendar or type it as 14/10/2026. Not before ' + CFG.EARLIEST;
    case 'time': return '24-hour time, hh:mm, for example 08:30';
    case 'text': return 'Text, at most ' + c.max + ' characters. Never a name or any other identifier';
    case 'sidnew': return 'Study number ' + idOf_(1) + ' to ' + idOf_(CFG.ID_MAX) + ', exactly as in the paper linking log. Once only in this tab';
    case 'sid': return 'A study number already entered in S1_ENROL. Once only in this tab';
    case 'sidl': return 'A study number already entered in S1_ENROL' + (c.pair ? '. One row per study number and ' + c.pair : '');
    case 'rid': return 'Study number, for example ' + idOf_(12) + '. One row per study number and read number';
    case 'unitnum': return 'Choose the unit first. Allowed: ' + Object.keys(c.ranges).map(function (k) { return k + ' ' + c.ranges[k][0] + ' to ' + c.ranges[k][1]; }).join('; ');
  }
  return '';
}
function csvField_(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function codeValues_(c) { return c.codes ? c.codes.map(function (p) { return p[0]; }) : (c.type === 'pairlist' ? c.values : null); }
function numericCodes_(c) { const v = codeValues_(c); return !!v && v.every(function (x) { return /^\d+$/.test(x); }); }
function spssIn_(c) {
  if (numericCodes_(c)) return 'F' + Math.max.apply(null, codeValues_(c).map(function (v) { return v.length; }));
  if (c.type === 'date') return 'SDATE10';
  if (c.type === 'time') return 'TIME5';
  if (['num', 'int', 'uniqueint', 'unitnum'].indexOf(c.type) >= 0) return 'F12';
  if (c.type === 'text') return 'A' + c.max;
  if (c.type === 'regex') return 'A' + (c.width || 10);
  if (['sidnew', 'sid', 'sidl', 'rid'].indexOf(c.type) >= 0) return 'A' + (CFG.ID_PREFIX.length + 3);
  const vals = c.codes ? c.codes.map(function (p) { return p[0]; }) : (c.values || ['x']);
  return 'A' + Math.max.apply(null, vals.map(function (v) { return v.length; }));
}
function spssQ_(s) { return String(s).replace(/'/g, "''"); }
function spssSyntax_() {
  const L = ['* TB-DM cohort: SPSS import syntax, generated by the data system v' + CFG.VERSION + '.',
    '* Keep this file in the same folder as the CSV files of one export.',
    '* Change the folder path in the CD command below, then run all of it.',
    '* Each tab becomes a dataset with variable and value labels and is saved as a .sav file.',
    "CD 'C:\\TBDM\\export'.", ''];
  const block = function (ds, file, cols) {
    L.push("GET DATA /TYPE=TXT /FILE='" + file + "' /ENCODING='UTF8'");
    L.push('  /ARRANGEMENT=DELIMITED /DELCASE=LINE /DELIMITERS="," /QUALIFIER=\'"\' /FIRSTCASE=2');
    L.push('  /VARIABLES=');
    cols.forEach(function (c) { L.push('    ' + c.key + ' ' + spssIn_(c)); });
    L.push('.');
    L.push('DATASET NAME ' + ds + ' WINDOW=FRONT.');
    L.push('VARIABLE LABELS ' + cols.map(function (c) { return c.key + " '" + spssQ_(c.label) + "'"; }).join('\n  /') + '.');
    cols.filter(function (c) { return c.codes; }).forEach(function (c) {
      const n = numericCodes_(c);
      L.push('VALUE LABELS ' + c.key + ' ' + c.codes.map(function (p) { return (n ? p[0] : "'" + spssQ_(p[0]) + "'") + " '" + spssQ_(p[1] || p[0]) + "'"; }).join(' ') + '.');
    });
    const blanks = cols.filter(function (c) { return codeValues_(c) && !numericCodes_(c); }).map(function (c) { return c.key; });
    if (blanks.length) L.push('MISSING VALUES ' + blanks.join(' ') + " (' ').");
    const dec = cols.filter(function (c) { return c.type === 'num' || c.type === 'unitnum'; }).map(function (c) { return c.key; });
    if (dec.length) L.push('FORMATS ' + dec.join(' ') + ' (F10.2).');
    L.push("SAVE OUTFILE='" + ds + ".sav'.", '');
  };
  SCHEMA.forEach(function (t) { block(t.tab, t.tab + '.csv', t.cols); });
  [1, 2].forEach(function (r) { block('CXR_Reader' + r, 'CXR_Reader' + r + '.csv', READER.cols); });
  return L.join('\n') + '\n';
}

// ============================================================================
//  GOOGLE SERVICES
// ============================================================================
function props_() { return PropertiesService.getScriptProperties(); }
function dataSS_() { const id = props_().getProperty('DATA_ID'); return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive(); }
function auditSS_() { return SpreadsheetApp.openById(props_().getProperty('AUDIT_ID')); }
function todayIso_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }
function emails_(key) { return (props_().getProperty(key) || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s !== ''; }); }
function piEmail_() { return (props_().getProperty('PI_EMAIL') || '').toLowerCase(); }
function me_() { return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase(); }
function requirePI_() { const pi = piEmail_(); if (!pi || me_() !== pi) throw new Error('Only the principal investigator (' + (pi || 'not yet set up') + ') can do this.'); }
function defOf_(name) { return SCHEMA.filter(function (t) { return t.tab === name; })[0]; }
function isText_(c) { return !!c.codes || ['text', 'regex', 'sidnew', 'sid', 'sidl', 'rid', 'pairlist'].indexOf(c.type) >= 0; }
function isCode_(c) { return !!c.codes || ['regex', 'sidnew', 'sid', 'sidl', 'rid', 'pairlist'].indexOf(c.type) >= 0; }
function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function notifyPI_(subject, body) { try { MailApp.sendEmail(piEmail_(), subject, body); } catch (e) { console.error('notifyPI_: ' + e); } }

function onOpen() {
  SpreadsheetApp.getUi().createMenu('TB-DM Study')
    .addItem('PI: refresh calculations, queries and alerts now', 'menuRefresh')
    .addItem('PI: manage users and sharing', 'menuUsers')
    .addItem('PI: draw the 10% verification sample', 'menuQcSample')
    .addItem('PI: export a snapshot (CSV and SPSS syntax)', 'menuExport')
    .addItem('PI: withdraw a participant', 'menuWithdraw')
    .addItem('PI: phone app: invite a team member', 'menuAppInvite')
    .addItem('PI: phone app: revoke access', 'menuAppRevoke')
    .addItem('PI: confidential link on or off', 'menuLinkSwitch')
    .addItem('PI: photos of documents on or off', 'menuPhotoSwitch')
    .addItem('PI: delete a participant\'s photos', 'menuPhotoDelete')
    .addItem('PI: erase ALL test data and start clean', 'menuEraseAll')
    .addSeparator()
    .addItem('PI: upgrade the workbook in place', 'menuUpgrade')
    .addItem('PI: update the script from GitHub', 'menuUpdateScript')
    .addItem('PI: how to update without re-inviting', 'menuUpdateHelp')
    .addItem('PI: set up or repair', 'setup')
    .addToUi();
}

// ---------------------------------------------------------------- setup
function setup() {
  const P = props_(), ui = SpreadsheetApp.getUi(), ss = SpreadsheetApp.getActive();
  const me = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (P.getProperty('PI_EMAIL') && P.getProperty('PI_EMAIL') !== me) throw new Error('Only the principal investigator (' + P.getProperty('PI_EMAIL') + ') can run setup.');
  checkHeaders_(ss, SCHEMA);
  P.setProperty('PI_EMAIL', me);
  P.setProperty('VERSION', CFG.VERSION);
  P.setProperty('SCHEMA_VER', String(CFG.SCHEMA_VER));
  P.setProperty('DATA_ID', ss.getId());
  const folder = buildAll_(ss);
  configureUsers_(ui);
  installTriggers_();
  refreshAll();
  integrityCheck_(ss);
  ui.alert('TB-DM data system v' + CFG.VERSION, 'Setup is complete.\n\nEverything is in the Google Drive folder "' + folder.getName() + '".\n\n' +
    'Next: ask every user to switch on 2-Step Verification. If this is the real study workbook, practise first in a separate ' +
    'practice system built the same way, never in a copy of this workbook. Use "PI: manage users and sharing" whenever the team changes.', ui.ButtonSet.OK);
}
function buildAll_(ss) {                                      // the non-interactive part of setup, also used by the upgrade
  ss.setSpreadsheetTimeZone(CFG.TZ);
  ss.setSpreadsheetLocale(CFG.LOCALE);
  const folder = ensureFolder_(ss);
  buildText_(ss, 'README', README_TEXT, '#000000');
  buildCodebook_(ss);
  SCHEMA.forEach(function (t) { buildTab_(ss, t); SpreadsheetApp.flush(); });
  Object.keys(DERIVED).forEach(function (n) { buildCalcTab_(ss, n, DERIVED[n].map(function (x) { return [x[0], x[2], x[1]]; })); });
  buildCalcTab_(ss, 'ALERTS', ALERT_SPEC.map(function (x) { return [x[0], x[1], 'Backup alerts only: the same-day clinical action never waits for this tab or for e-mail']; }));
  const s1 = ss.getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  ensureAuditFile_(folder);
  ensureReaderFiles_(folder);
  ensureRegisterFile_(folder);
  return folder;
}
function checkHeaders_(ss, defs) {
  defs.forEach(function (t) {
    const sh = ss.getSheetByName(t.tab);
    if (!sh || sh.getLastColumn() === 0) return;
    const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].filter(function (x) { return String(x).trim() !== ''; });
    const want = t.cols.map(function (c) { return c.key; });
    if (have.length && have.join('|') !== want.join('|')) {
      throw new Error('Tab ' + t.tab + ' in ' + ss.getName() + ' has different column headers from this script, so setup stopped without changing anything. Use "PI: upgrade the workbook in place" instead.');
    }
  });
}
function ensureFolder_(ss) {
  const P = props_(), id = P.getProperty('FOLDER_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* create a new one */ } }
  const f = DriveApp.createFolder('TBDM Study Data System (' + ss.getName() + ')');
  P.setProperty('FOLDER_ID', f.getId());
  DriveApp.getFileById(ss.getId()).moveTo(f);
  return f;
}
function styleHeader_(sh, n, freezeCols) {
  sh.getRange(1, 1, 1, n).setFontWeight('bold').setBackground('#d9e2f3').setWrap(true).setVerticalAlignment('top');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(freezeCols || 1);
  sh.setRowHeight(1, 42);
}
function sizeSheet_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}
function buildRule_(c, i, t) {
  const b = SpreadsheetApp.newDataValidation().setAllowInvalid(false).setHelpText(helpText_(c));
  if (c.codes) return b.requireValueInList(c.codes.map(function (p) { return p[0]; }), true).build();
  if (c.type === 'num') return b.requireNumberBetween(c.min, c.max).build();
  if (c.type === 'date') { const d = CFG.EARLIEST.split('-'); return b.requireDateOnOrAfter(new Date(+d[0], +d[1] - 1, +d[2])).build(); }
  const f = validationFormula_(c, colLetter_(i + 1), t);
  return f ? b.requireFormulaSatisfied(f).build() : null;
}
function applyColumn_(sh, t, c, i) {
  sizeSheet_(sh, t.rows, t.cols.length);                     // rows may have been deleted since setup
  const rng = sh.getRange(2, i + 1, t.rows - 1, 1);
  if (c.type === 'date') rng.setNumberFormat('yyyy-mm-dd');
  else if (c.type === 'time') rng.setNumberFormat('hh:mm');
  else if (isText_(c)) rng.setNumberFormat('@');
  const rule = buildRule_(c, i, t);
  if (rule) rng.setDataValidation(rule); else rng.clearDataValidations();
  if (c.pi) rng.setBackground('#fff2cc');
}
function buildTab_(ss, t) {
  const sh = ss.getSheetByName(t.tab) || ss.insertSheet(t.tab), n = t.cols.length;
  sizeSheet_(sh, t.rows, n);
  sh.getRange(1, 1, 1, n).setValues([t.cols.map(function (c) { return c.key; })])
    .setNotes([t.cols.map(function (c) { return c.label + '\n' + helpText_(c) + (c.pi ? '\nEntered by the PI only.' : ''); })]);
  styleHeader_(sh, n, t.kind === 'long' ? 2 : 1);
  t.cols.forEach(function (c, i) { applyColumn_(sh, t, c, i); });
  sh.setColumnWidths(1, n, 120);
  sh.setTabColor(t.kind === 'long' ? '#6aa84f' : t.kind === 'log' ? '#e69138' : '#3c78d8');
  sh.setConditionalFormatRules(flagRules_(sh, t));
  return sh;
}
function flagRules_(sh, t) {
  const keys = t.cols.map(function (c) { return c.key; }), K = function (k) { return colLetter_(keys.indexOf(k) + 1); };
  const rng = sh.getRange(2, 1, t.rows - 1, keys.length), rules = [];
  const add = function (f, colour) { rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f).setBackground(colour).setRanges([rng]).build()); };
  if (t.tab === 'PHQ_GAD') add('=IFERROR(VALUE($' + K('phq9') + '2)>0,FALSE)', '#f4cccc');
  if (t.tab === 'LABS') add('=OR(AND(ISNUMBER($' + K('alt') + '2),ISNUMBER($' + K('alt_uln') + '2),$' + K('alt') + '2>=3*$' + K('alt_uln') + '2),AND(ISNUMBER($' + K('ast') + '2),ISNUMBER($' + K('ast_uln') + '2),$' + K('ast') + '2>=3*$' + K('ast_uln') + '2))', '#fce5cd');
  if (t.tab === 'VISITS') add('=COUNTIF($' + K(HEP[0]) + '2:$' + K(HEP[HEP.length - 1]) + '2,"Y")>0', '#fce5cd');
  if (t.tab === 'S0_SCREEN') add('=AND($' + K('eligible') + '2="Y",$' + K('enrolled') + '2="")', '#fff2cc');
  if (t.tab === 'EVENTS') add('=$' + K('serious') + '2="Y"', '#f4cccc');
  return rules;
}
function buildCalcTab_(ss, name, spec) {            // spec: [key, type d/n/t/x, description]
  const sh = ss.getSheetByName(name) || ss.insertSheet(name), n = spec.length;
  sizeSheet_(sh, 100, n);
  sh.getRange(1, 1, 1, n).setValues([spec.map(function (x) { return x[0]; })]).setNotes([spec.map(function (x) { return x[2]; })]);
  styleHeader_(sh, n, 1);
  spec.forEach(function (x, i) {
    const r = sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1);
    if (x[1] === 'd') r.setNumberFormat('yyyy-mm-dd'); else if (x[1] === 't') r.setNumberFormat('@'); else if (x[1] === 'x') r.setNumberFormat('yyyy-mm-dd hh:mm');
  });
  sh.setColumnWidths(1, n, 130);
  sh.setTabColor('#999999');
}
function buildText_(ss, name, lines, colour) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  sizeSheet_(sh, lines.length + 2, 1);
  sh.getRange(1, 1, lines.length, 1).setNumberFormat('@').setValues(lines.map(function (x) { return [x]; })).setWrap(true);
  sh.setColumnWidth(1, 900);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  lines.forEach(function (x, i) { if (x && x === x.toUpperCase() && /[A-Z]/.test(x)) sh.getRange(i + 1, 1).setFontWeight('bold'); });
  sh.setTabColor(colour);
  if (name === 'README') { ss.setActiveSheet(sh); ss.moveActiveSheet(1); }
}
function buildCodebook_(ss) {
  const rows = [['tab', 'column', 'variable', 'label', 'type', 'allowed values or range', 'entered by']];
  SCHEMA.concat([READER]).forEach(function (t) {
    t.cols.forEach(function (c, i) {
      rows.push([t.tab === 'R_SCORES' ? 'TBDM_CXR_Reader1/2 R_SCORES' : t.tab, colLetter_(i + 1), c.key, c.label, c.type === 'list' ? 'code' : c.type, helpText_(c),
        t.tab === 'R_SCORES' ? 'radiograph reader' : c.pi ? 'PI only' : t.tab === 'QC_LOG' ? 'verifier' : 'data entry']);
    });
  });
  Object.keys(DERIVED).forEach(function (n) { DERIVED[n].forEach(function (x, i) { rows.push([n, colLetter_(i + 1), x[0], x[1], 'calculated', '', 'automatic']); }); });
  const sh = ss.getSheetByName('CODEBOOK') || ss.insertSheet('CODEBOOK');
  sh.clear();
  sizeSheet_(sh, rows.length + 1, rows[0].length);
  sh.getRange(1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
  styleHeader_(sh, rows[0].length, 1);
  sh.setColumnWidths(1, rows[0].length, 170);
  sh.setTabColor('#999999');
}
function ensureAuditFile_(folder) {
  const P = props_();
  let a = null;
  const id = P.getProperty('AUDIT_ID');
  if (id) { try { a = SpreadsheetApp.openById(id); } catch (e) { a = null; } }
  if (!a) {
    a = SpreadsheetApp.create('TBDM_AuditLog (PI only)');
    DriveApp.getFileById(a.getId()).moveTo(folder);
    P.setProperty('AUDIT_ID', a.getId());
    a.getSheets()[0].setName('LOG');
  }
  a.setSpreadsheetTimeZone(CFG.TZ);
  const tabs = {
    LOG: ['timestamp', 'user', 'file_tab', 'cell', 'study_id', 'old_value', 'new_value', 'note'],
    SNAPSHOTS: ['timestamp', 'file_tab', 'rows_with_data', 'sha256'],
    DELETIONS: ['timestamp', 'study_id', 'action', 'by', 'note']
  };
  Object.keys(tabs).forEach(function (n) {
    const sh = a.getSheetByName(n) || a.insertSheet(n);
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, tabs[n].length).setValues([tabs[n]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (n !== 'SNAPSHOTS') sh.getRange(2, 2, sh.getMaxRows() - 1, tabs[n].length - 1).setNumberFormat('@');
  });
  return a;
}
// The study numbers register: a separate file, owned by the PI only. The phone reaches it through the script (which runs as the PI),
// so the DOTS incharge needs no access to the file itself. Created once; an existing register is never replaced.
function ensureRegisterFile_(folder) {
  const P = props_(), id = P.getProperty('REGISTER_ID');
  let r = null;
  if (id) { try { r = SpreadsheetApp.openById(id); } catch (e) { r = null; } }
  if (!r) {
    r = SpreadsheetApp.create('TBDM_NumbersRegister (PI only)');
    DriveApp.getFileById(r.getId()).moveTo(folder);
    P.setProperty('REGISTER_ID', r.getId());
    r.getSheets()[0].setName(REG_TAB);
  }
  r.setSpreadsheetTimeZone(CFG.TZ);
  const sh = r.getSheetByName(REG_TAB) || r.insertSheet(REG_TAB);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, REG_COLS.length).setValues([REG_COLS]).setFontWeight('bold');
  if (str_(sh.getRange(1, 2).getValue()) === REG_COLS[1]) sh.getRange(1, 7, sh.getMaxRows(), 2).setNumberFormat('@');   // record number and telephone stay text
  sh.setFrozenRows(1);
  return r;
}
function ensureReaderFiles_(folder) {
  const P = props_();
  [1, 2].forEach(function (r) {
    const key = 'READER' + r + '_ID';
    let f = null;
    const id = P.getProperty(key);
    if (id) { try { f = SpreadsheetApp.openById(id); } catch (e) { f = null; } }
    if (!f) {
      f = SpreadsheetApp.create('TBDM_CXR_Reader' + r);
      DriveApp.getFileById(f.getId()).moveTo(folder);
      P.setProperty(key, f.getId());
      f.getSheets()[0].setName(READER.tab);
    }
    f.setSpreadsheetTimeZone(CFG.TZ);
    f.setSpreadsheetLocale(CFG.LOCALE);
    checkHeaders_(f, [READER]);
    buildTab_(f, READER);
    buildText_(f, 'INSTRUCTIONS', READER_TEXT, '#000000');
  });
}

// ---------------------------------------------------------------- users, sharing, protection
function menuUsers() { requirePI_(); configureUsers_(SpreadsheetApp.getUi()); }
function configureUsers_(ui) {
  const P = props_(), valid = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;
  const roles = [
    ['ALERT_EMAILS', 'Backup alert e-mails (the PI and the DOTS incharge), separated by commas'],
    ['DATA_EMAILS', 'Data entry staff: their Google account e-mails, separated by commas. They can enter data in the data tabs only'],
    ['QC_EMAILS', 'Verifier (the records custodian): Google account e-mail. Can view every tab and write only in QC_LOG'],
    ['READER1_EMAIL', 'Radiograph reader 1: Google account e-mail. Can open only the reader 1 file'],
    ['READER2_EMAIL', 'Radiograph reader 2: Google account e-mail. Can open only the reader 2 file'],
    ['DOTS_EMAILS', 'DOTS incharge: Google account e-mail. Can use the study numbers register on the phone only, never the workbook'],
    ['NURSE_EMAILS', 'Measurement nurse or staff: any e-mail address (a Google account is not needed). Phone app only, never the workbook. Can enter screening, enrolment, height, weight, waist and arm measurements, and sees nothing else']];
  roles.forEach(function (x) {
    const cur = P.getProperty(x[0]) || '';
    const r = ui.prompt('Study users', x[1] + '.\n\nNow: ' + (cur || 'nobody') + '\n\nType the new list to replace it, a single hyphen to clear it, or leave blank to keep it.', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    const v = r.getResponseText().trim();
    if (v === '-') { P.setProperty(x[0], ''); return; }
    if (!v) return;
    const list = v.split(/[\s,;]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s !== ''; });
    const bad = list.filter(function (s) { return !valid.test(s); });
    if (bad.length) { ui.alert('Not saved', 'These are not e-mail addresses: ' + bad.join(', ') + '. The previous list was kept.', ui.ButtonSet.OK); return; }
    P.setProperty(x[0], list.join(','));
  });
  const res = applyAccess_(ui);
  ui.alert('Users and sharing', 'Access added:\n' + (res.added.join('\n') || 'none') + '\n\nAccess removed:\n' + (res.removed.join('\n') || 'none') +
    '\n\nLink sharing is off and editors cannot re-share. Protections were rebuilt.', ui.ButtonSet.OK);
}
function applyAccess_(ui) {
  const P = props_(), pi = piEmail_();
  const uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
  const plan = [
    { id: P.getProperty('DATA_ID'), editors: uniq(emails_('DATA_EMAILS').concat(emails_('QC_EMAILS'))) },
    { id: P.getProperty('READER1_ID'), editors: emails_('READER1_EMAIL') },
    { id: P.getProperty('READER2_ID'), editors: emails_('READER2_EMAIL') },
    { id: P.getProperty('AUDIT_ID'), editors: [] },
    { id: P.getProperty('REGISTER_ID'), editors: [] }].filter(function (p) { return !!p.id; });
  const out = { added: [], removed: [] }, extra = [];
  plan.forEach(function (p) {
    const f = DriveApp.getFileById(p.id);
    f.getEditors().concat(f.getViewers()).forEach(function (u) {
      const em = (u.getEmail() || '').toLowerCase();
      if (em && em !== pi && p.editors.indexOf(em) < 0) extra.push({ f: f, u: u, em: em });
    });
  });
  if (extra.length && ui) {
    const yes = ui.alert('Remove access?', 'These people can open study files but are not in the study user lists:\n' +
      extra.map(function (x) { return x.f.getName() + ': ' + x.em; }).join('\n') + '\n\nRemove their access now?', ui.ButtonSet.YES_NO);
    if (yes === ui.Button.YES) extra.forEach(function (x) {
      try { x.f.removeEditor(x.u); } catch (e) { /* was a viewer */ }
      try { x.f.removeViewer(x.u); } catch (e) { /* was an editor */ }
      out.removed.push(x.f.getName() + ': ' + x.em);
    });
  }
  plan.forEach(function (p) {
    const f = DriveApp.getFileById(p.id);
    try { f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) { console.error('setSharing: ' + e); }
    try { f.setShareableByEditors(false); } catch (e) { console.error('setShareableByEditors: ' + e); }
    const have = f.getEditors().map(function (u) { return (u.getEmail() || '').toLowerCase(); });
    p.editors.forEach(function (em) { if (em !== pi && have.indexOf(em) < 0) { f.addEditor(em); out.added.push(f.getName() + ': ' + em); } });
  });
  protectAll_(SpreadsheetApp.openById(P.getProperty('DATA_ID')));
  [1, 2].forEach(function (r) { const id = P.getProperty('READER' + r + '_ID'); if (id) protectReader_(SpreadsheetApp.openById(id)); });
  return out;
}
function removeOwnProtections_(ss) {
  ss.getProtections(SpreadsheetApp.ProtectionType.SHEET).concat(ss.getProtections(SpreadsheetApp.ProtectionType.RANGE)).forEach(function (p) {
    if ((p.getDescription() || '').indexOf(CFG.TAG) === 0) p.remove();
  });
}
function lock_(p, editors) {
  const pi = piEmail_(), keep = [pi].concat(editors);
  p.addEditor(pi);
  if (editors.length) p.addEditors(editors);
  const drop = p.getEditors().filter(function (u) { return keep.indexOf((u.getEmail() || '').toLowerCase()) < 0; });
  if (drop.length) p.removeEditors(drop);
  if (p.canDomainEdit()) p.setDomainEdit(false);
  return p;
}
function protectAll_(ss) {
  const data = emails_('DATA_EMAILS'), qc = emails_('QC_EMAILS');
  removeOwnProtections_(ss);
  ['README', 'CODEBOOK', 'ALERTS'].concat(Object.keys(DERIVED)).forEach(function (n) {
    const sh = ss.getSheetByName(n);
    if (sh) lock_(sh.protect().setDescription(CFG.TAG + ' ' + n + ': PI only'), []);
  });
  SCHEMA.forEach(function (t) {
    const sh = ss.getSheetByName(t.tab);
    if (!sh) return;
    sizeSheet_(sh, t.rows, t.cols.length);
    const who = t.tab === 'QC_LOG' ? qc : data;
    lock_(sh.protect().setDescription(CFG.TAG + ' ' + t.tab + ': PI and ' + (t.tab === 'QC_LOG' ? 'verifier' : 'data entry')), who);
    lock_(sh.getRange(1, 1, 1, t.cols.length).protect().setDescription(CFG.TAG + ' ' + t.tab + ' header: PI only'), []);
    t.cols.forEach(function (c, i) {
      if (c.pi) lock_(sh.getRange(2, i + 1, t.rows - 1, 1).protect().setDescription(CFG.TAG + ' ' + t.tab + ' ' + c.key + ': PI only'), []);
    });
  });
}
function protectReader_(f) {
  removeOwnProtections_(f);
  const sh = f.getSheetByName(READER.tab);
  if (sh) lock_(sh.getRange(1, 1, 1, READER.cols.length).protect().setDescription(CFG.TAG + ' header: PI only'), []);
  const ins = f.getSheetByName('INSTRUCTIONS');
  if (ins) lock_(ins.protect().setDescription(CFG.TAG + ' instructions: PI only'), []);
}
function installTriggers_() {
  const P = props_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['auditOnEdit', 'auditOnChange', 'hourlyJob', 'dailyJob'].indexOf(t.getHandlerFunction()) >= 0) {
      P.deleteProperty('TRIG_' + t.getUniqueId());
      ScriptApp.deleteTrigger(t);
    }
  });
  ['DATA_ID', 'READER1_ID', 'READER2_ID'].forEach(function (k) {
    const id = P.getProperty(k);
    if (!id) return;
    ScriptApp.newTrigger('auditOnEdit').forSpreadsheet(id).onEdit().create();
    const t = ScriptApp.newTrigger('auditOnChange').forSpreadsheet(id).onChange().create();
    P.setProperty('TRIG_' + t.getUniqueId(), SpreadsheetApp.openById(id).getName());
  });
  ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(21).inTimezone(CFG.TZ).create();
}

// ---------------------------------------------------------------- audit trail
function cellText_(v) { return v === undefined || v === null ? '' : String(v); }
function readable_(tab, key, v) {                 // Google passes old dates and times as serial numbers
  const t = defOf_(tab) || (tab.indexOf(READER.tab) >= 0 ? READER : null);
  const c = t ? t.cols.filter(function (x) { return x.key === key; })[0] : null, x = num_(v);
  if (!c || x === null) return cellText_(v);
  if (c.type === 'date' && x > 20000 && x < 80000) return isoOf_(Math.round(x) - 25569);
  if (c.type === 'time' && x >= 0 && x < 1) { const m = Math.round(x * 1440); return pad2_(Math.floor(m / 60)) + ':' + pad2_(m % 60); }
  return cellText_(v);
}
function logAudit_(label, cell, sid, oldV, newV, note, user) {
  try {
    auditSS_().getSheetByName('LOG').appendRow([new Date(), user || me_() || 'unknown', label, cell || '', sid || '', cellText_(oldV), cellText_(newV), note || '']);
  } catch (err) { console.error('audit log unavailable: ' + err); }
}
// Installable trigger on the data file and both reader files. It runs as the PI, so it can
// write to the audit file that nobody else can open. Edits made by scripts do not reach it;
// those are logged by the functions that make them.
function auditOnEdit(e) {
  try {
    if (!e || !e.range) return;
    const r = e.range, sh = r.getSheet(), file = e.source || sh.getParent(), P = props_();
    const isMain = file.getId() === P.getProperty('DATA_ID');
    const label = (isMain ? '' : file.getName() + '/') + sh.getName();
    let user = '';
    try { user = e.user && e.user.getEmail ? e.user.getEmail() : ''; } catch (err) { user = ''; }
    user = user || 'not shown by Google (see entered_by and version history)';
    const head = sh.getLastColumn() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0] : [];
    const k = head.indexOf('study_id') + 1, r1 = Math.max(2, r.getRow()), r2 = r.getLastRow();
    const sids = k > 0 && r2 >= r1 ? sh.getRange(r1, k, r2 - r1 + 1, 1).getDisplayValues().map(function (x) { return String(x[0]).trim().toUpperCase(); }) : [];
    const single = r.getNumRows() === 1 && r.getNumColumns() === 1;
    if (single) {
      const key = head[r.getColumn() - 1] || '';
      logAudit_(label, r.getA1Notation(), sids[0] || '', readable_(sh.getName(), key, e.oldValue), r.getDisplayValue(), key, user);
    }
    else logAudit_(label, r.getA1Notation(), sids.filter(function (s) { return s; }).join(' ').slice(0, 300), '(Google gives no old values for multi-cell edits)',
      JSON.stringify(r.getDisplayValues()).slice(0, 45000), 'multi-cell edit', user);
    if (!isMain || !ALERT_COLS[sh.getName()] || r2 < 2) return;
    const touched = head.slice(r.getColumn() - 1, r.getColumn() - 1 + r.getNumColumns());
    if (!touched.some(function (h) { return ALERT_COLS[sh.getName()].indexOf(h) >= 0; })) return;
    const want = sids.filter(function (s, i) { return s && sids.indexOf(s) === i; });
    if (want.length) alertsFor_(file, want);
  } catch (err) { console.error('auditOnEdit: ' + (err && err.stack ? err.stack : err)); }
}

// Installable change trigger. Deleting a row, column or tab never reaches onEdit, so it is logged
// here and reported to the PI at once; the daily row count check is the second line of defence.
function auditOnChange(e) {
  try {
    if (!e || !e.changeType || e.changeType === 'EDIT' || e.changeType === 'FORMAT') return;
    let user = '';
    try { user = e.user && e.user.getEmail ? e.user.getEmail() : ''; } catch (err) { user = ''; }
    const name = props_().getProperty('TRIG_' + e.triggerUid) || 'a study file';
    logAudit_(name, '', '', '', e.changeType, 'structural change', user || 'not shown by Google');
    if (/^REMOVE_/.test(e.changeType)) {
      const what = { REMOVE_ROW: 'a row', REMOVE_COLUMN: 'a column', REMOVE_GRID: 'a whole tab' }[e.changeType] || 'something';
      notifyPI_('[TBDM] ' + what + ' was deleted in ' + name, 'Someone deleted ' + what + ' in ' + name + ' at ' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm') +
        (user ? ' (' + user + ')' : '') + '.\n\nIf this was not a planned correction, restore it from File > Version history. Every value that was typed is also in TBDM_AuditLog.');
    }
  } catch (err) { console.error('auditOnChange: ' + err); }
}

// ---------------------------------------------------------------- calculations, queries, alerts
// The column layout the workbook actually has (set by setup and by the in-place upgrade; workbooks made before v1.2 have none, which means 1).
// Until it matches this script, nothing reads or writes study rows: the old layout would be read with the new column map.
function wbSchema_() { const v = Number(props_().getProperty('SCHEMA_VER')); return v > 0 ? v : 1; }
const UPGRADE_PENDING = 'The workbook still has the old column layout. The PI must run "PI: upgrade the workbook in place" first. Nothing was read or changed.';
function requireSchema_() { if (wbSchema_() !== CFG.SCHEMA_VER) throw new Error(UPGRADE_PENDING); }
function readTab_(ss, def) {
  requireSchema_();
  const sh = ss.getSheetByName(def.tab);
  if (!sh || sh.getLastRow() < 2) return [];
  const n = def.cols.length, vals = sh.getRange(2, 1, sh.getLastRow() - 1, n).getDisplayValues(), out = [];
  vals.forEach(function (row, i) {
    if (!row.some(function (v) { return String(v).trim() !== ''; })) return;
    const o = { _row: i + 2 };
    def.cols.forEach(function (c, j) { const v = cellText_(row[j]).trim(); o[c.key] = isCode_(c) ? v.toUpperCase() : v; });
    out.push(o);
  });
  return out;
}
function readAll_(ss) { const d = {}; SCHEMA.forEach(function (t) { d[t.tab] = readTab_(ss, t); }); return d; }
function writeTable_(ss, name, rows) {
  const sh = ss.getSheetByName(name);
  if (!sh) return;
  const spec = DERIVED[name], w = spec.length;
  sizeSheet_(sh, rows.length + 1, w);
  sh.getRange(1, 1, 1, w).setValues([spec.map(function (x) { return x[0]; })]);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, w).clearContent();
  if (!rows.length) return;
  spec.forEach(function (x, i) {
    if (x[2] === 'd') sh.getRange(2, i + 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    else if (x[2] === 't') sh.getRange(2, i + 1, rows.length, 1).setNumberFormat('@');
  });
  sh.getRange(2, 1, rows.length, w).setValues(rows);
}
// QUERIES: a link to the exact cell (or to the next empty row when a whole row is missing).
function queryLinks_(ss, qs) {
  const gid = {}, heads = {}, last = {};
  SCHEMA.forEach(function (t) { const sh = ss.getSheetByName(t.tab); if (!sh) return; gid[t.tab] = sh.getSheetId(); heads[t.tab] = t.cols.map(function (c) { return c.key; }); last[t.tab] = Math.max(sh.getLastRow(), 1); });
  return qs.map(function (q) {
    if (gid[q[1]] === undefined) return q.slice(0, 7).concat(['']);
    const ci = heads[q[1]].indexOf(q[6]), row = q[2] || last[q[1]] + 1;
    const a1 = colLetter_(ci >= 0 ? ci + 1 : 1) + row;
    return q.slice(0, 7).concat(['=HYPERLINK("#gid=' + gid[q[1]] + '&range=' + a1 + '","Go to ' + q[1] + ' ' + a1 + '")']);
  });
}
// Cells with an open query are shaded yellow in their data tab until the query clears (next refresh).
function highlightQueries_(ss, qs) {
  SCHEMA.forEach(function (t) {
    const sh = ss.getSheetByName(t.tab); if (!sh || t.tab === 'QC_LOG') return;
    try {
    sizeSheet_(sh, t.rows, t.cols.length);
    const keys = t.cols.map(function (c) { return c.key; }), seen = {}, ranges = [];
    qs.forEach(function (q) {
      if (q[1] !== t.tab || !q[2]) return;
      const ci = keys.indexOf(q[6]), k = q[2] + ':' + ci;
      if (seen[k] || ranges.length >= 400) return; seen[k] = 1;
      ranges.push(ci >= 0 ? sh.getRange(q[2], ci + 1) : sh.getRange(q[2], 1, 1, keys.length));
    });
    const rules = flagRules_(sh, t);
    if (ranges.length) rules.unshift(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=TRUE').setBackground('#fff2a8').setRanges(ranges).build());
    sh.setConditionalFormatRules(rules);
    } catch (err) { console.warn('highlightQueries_ ' + t.tab + ': ' + err); }   // shading is a help, never a reason to stop the refresh
  });
}
function refreshAll() {
  if (wbSchema_() !== CFG.SCHEMA_VER) { console.warn(UPGRADE_PENDING); return false; }   // scheduled runs wait quietly for the upgrade
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return false;
  try {
    const ss = dataSS_(), out = computeDerived_(readAll_(ss), todayIso_(), heldBlocks_());
    writeTable_(ss, 'DERIVED_PARTICIPANT', out.participant);
    writeTable_(ss, 'DERIVED_LABS', out.labs);
    writeTable_(ss, 'DERIVED_VISITS', out.visits);
    writeTable_(ss, 'SCHEDULE', out.schedule);
    writeTable_(ss, 'QUERIES', queryLinks_(ss, out.queries));
    highlightQueries_(ss, out.queries);
    writeTable_(ss, 'SUMMARY', [['Calculated at', Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm')]].concat(out.summary));
    raiseAlertsLocked_(ss, out.alerts);
    return true;
  } finally { lock.releaseLock(); }
}
function alertsFor_(ss, sids) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;               // the hourly job will catch it
  try {
    const want = {};
    sids.forEach(function (s) { want[s] = true; });
    const data = {};
    ['S1_ENROL', 'LABS', 'VISITS', 'PHQ_GAD'].forEach(function (n) { data[n] = readTab_(ss, defOf_(n)).filter(function (r) { return want[r.study_id]; }); });
    raiseAlertsLocked_(ss, computeDerived_(data, todayIso_(), heldBlocks_()).alerts);
  } finally { lock.releaseLock(); }
}
function raiseAlertsLocked_(ss, alerts) {
  const sh = ss.getSheetByName('ALERTS');
  if (!sh) return;
  const seen = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().map(function (r) { return r[0]; }) : [];
  alerts.forEach(function (a) {
    if (seen.indexOf(a.key) >= 0) return;
    let to = '';
    try { to = sendAlert_(a); } catch (err) { to = 'E-MAIL FAILED: ' + err; }
    sh.appendRow([a.key, a.type, a.study_id, a.visit, a.rule, new Date(), to, '', '', '']);
    seen.push(a.key);
  });
}
function sendAlert_(a) {
  const list = emails_('ALERT_EMAILS'), to = (list.length ? list : [piEmail_()]).join(',');
  const action = a.type === 'E1'
    ? 'Same-day risk assessment and psychiatry referral (protocol Section 10.2); then form E1.'
    : a.type === 'E2'
      ? 'The treating team must be told today (protocol Section 7.7); then form E2.'
      : 'Record the hepatotoxicity symptom enquiry for this visit today. If any symptom or jaundice, the liver injury definition is met: tell the treating team today.';
  MailApp.sendEmail(to, '[TBDM] ' + a.type + ' alert: ' + a.study_id + ' ' + a.visit,
    'Study number: ' + a.study_id + '\nVisit: ' + a.visit + '\nFinding: ' + a.rule + '\n\nRequired: ' + action +
    '\n\nThis e-mail is only a backup. The same-day clinical action should already be under way.');
  return to;
}

// ---------------------------------------------------------------- scheduled jobs
function hourlyJob() {
  const ss = dataSS_();
  try { pullReaders_(ss); } catch (e) { console.error('pullReaders_: ' + e); }
  refreshAll();
}
function dailyJob() {
  const ss = dataSS_(), problems = integrityCheck_(ss);
  if (problems.length) notifyPI_('[TBDM] Daily integrity check: action needed', 'The daily check found:\n\n- ' + problems.join('\n- ') +
    '\n\nDeleted or cleared values can be recovered from File > Version history in the study file; every change is in TBDM_AuditLog.');
  if (Utilities.formatDate(new Date(), CFG.TZ, 'EEE') === 'Sun') {
    refreshAll();
    const f = exportSnapshot_(ss, 'weekly');
    notifyPI_('[TBDM] Weekly summary and export', weeklyText_(ss) + '\n\nExport saved in Google Drive: ' + CFG.EXPORTS + '/' + f.getName());
  }
}
function weeklyText_(ss) {
  const sh = ss.getSheetByName('SUMMARY');
  if (!sh || sh.getLastRow() < 2) return 'No summary yet.';
  return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().map(function (r) { return r[0] + ': ' + r[1]; }).join('\n');
}
function lastSnapshot_() {
  const sh = auditSS_().getSheetByName('SNAPSHOTS'), m = {};
  if (sh.getLastRow() < 2) return m;
  sh.getRange(2, 2, sh.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) { m[r[0]] = +r[1]; });
  return m;
}
function integrityCheck_(ss) {
  const P = props_(), problems = [], snap = [], last = lastSnapshot_(), now = new Date();
  const files = [{ ss: ss, defs: SCHEMA, prefix: '' }];
  [1, 2].forEach(function (r) { const id = P.getProperty('READER' + r + '_ID'); if (id) files.push({ ss: SpreadsheetApp.openById(id), defs: [READER], prefix: 'TBDM_CXR_Reader' + r + '/' }); });
  files.forEach(function (f) {
    f.defs.forEach(function (t) {
      const label = f.prefix + t.tab, sh = f.ss.getSheetByName(t.tab);
      if (!sh) { problems.push(label + ': tab is missing'); return; }
      const head = sh.getRange(1, 1, 1, t.cols.length).getDisplayValues()[0];
      if (head.join('|') !== t.cols.map(function (c) { return c.key; }).join('|')) problems.push(label + ': column headers have changed');
      const rows = readTab_(f.ss, t);
      if (last[label] !== undefined && rows.length < last[label]) problems.push(label + ': rows with data fell from ' + last[label] + ' to ' + rows.length + ', so a row was deleted or cleared');
      snap.push([now, label, rows.length, sha256_(JSON.stringify(rows))]);
      const upto = Math.min(t.rows, Math.max(sh.getLastRow(), 2) + 5);
      const dv = sh.getRange(2, 1, upto - 1, t.cols.length).getDataValidations();
      const broken = t.cols.filter(function (c, j) { return dv.some(function (row) { return !row[j]; }); });
      if (broken.length) {
        broken.forEach(function (c) { applyColumn_(sh, t, c, t.cols.indexOf(c)); });
        problems.push(label + ': checks were missing (usually after a plain paste) and have been restored in ' + broken.map(function (c) { return c.key; }).join(', '));
      }
    });
  });
  if (snap.length) { const s = auditSS_().getSheetByName('SNAPSHOTS'); s.getRange(s.getLastRow() + 1, 1, snap.length, 4).setValues(snap); }
  return problems;
}

// ---------------------------------------------------------------- radiograph readers
function numOrText_(v) { const x = num_(v); return x === null ? str_(v) : x; }
function pullReaders_(ss) {
  const P = props_(), def = defOf_('S3_CXR'), sh = ss.getSheetByName('S3_CXR');
  if (!sh || sh.getLastRow() < 2) return 0;
  const keys = def.cols.map(function (c) { return c.key; }), n = sh.getLastRow() - 1;
  const sids = sh.getRange(2, 1, n, 1).getDisplayValues().map(function (r) { return String(r[0]).trim().toUpperCase(); });
  let changes = 0;
  [1, 2].forEach(function (r) {
    const id = P.getProperty('READER' + r + '_ID');
    if (!id) return;
    const m = {};
    readTab_(SpreadsheetApp.openById(id), READER).forEach(function (x) { if (x.read_no === '1' && x.study_id) m[x.study_id] = x; });
    const c0 = keys.indexOf('r' + r + '_pct') + 1, cur = sh.getRange(2, c0, n, 3).getDisplayValues();
    const changed = [];
    const next = cur.map(function (row, i) {
      const x = m[sids[i]];
      if (!x) return row;
      const want = [pctFromQuadrants_(x) || x.pct_lung, x.cavity, x.n_cavities];          // the quadrant mean wins over a typed percentage
      if (want.join('|') !== row.join('|')) changed.push(sids[i]);
      return want;
    });
    if (changed.length) {
      sh.getRange(2, c0, n, 3).setValues(next.map(function (row) { return [numOrText_(row[0]), str_(row[1]), numOrText_(row[2])]; }));
      changes += changed.length;
      logAudit_('S3_CXR', '', changed.join(' ').slice(0, 300), '', '', 'reader ' + r + ' scores pulled for ' + changed.length + ' film(s)', 'system');
    }
  });
  return changes;
}

// ---------------------------------------------------------------- PI menu actions
function menuRefresh() {
  requirePI_();
  const n = pullReaders_(dataSS_()), ok = refreshAll();
  SpreadsheetApp.getUi().alert('Refreshed', (ok ? 'Calculations, SCHEDULE, QUERIES, SUMMARY and ALERTS are up to date.' : 'Another update was running; try again in a minute.') +
    '\nReader scores updated for ' + n + ' film(s).', SpreadsheetApp.getUi().ButtonSet.OK);
}
function menuQcSample() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), ss = dataSS_();
  const ids = readTab_(ss, defOf_('S1_ENROL')).map(function (r) { return r.study_id; }).filter(idOk_);
  if (!ids.length) { ui.alert('No participants', 'Nobody is enrolled yet.', ui.ButtonSet.OK); return; }
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
  const pick = ids.slice(0, Math.max(1, Math.ceil(ids.length * 0.1))).sort();
  const qc = ss.getSheetByName('QC_LOG');
  let no = readTab_(ss, defOf_('QC_LOG')).reduce(function (m, r) { return Math.max(m, num_(r.qc_no) || 0); }, 0);
  qc.getRange(qc.getLastRow() + 1, 1, pick.length, 5).setValues(pick.map(function (sid) { no++; return [no, '', sid, 'ALL', 'ALL']; }));
  logAudit_('QC_LOG', '', pick.join(' ').slice(0, 300), '', '', '10% verification sample drawn', '');
  ui.alert('Verification sample', 'Sample: ' + pick.join(', ') + '\n\nCheck every field for these participants against the source documents and complete their rows in QC_LOG.', ui.ButtonSet.OK);
}
function menuExport() {
  requirePI_();
  refreshAll();
  const f = exportSnapshot_(dataSS_(), 'manual');
  SpreadsheetApp.getUi().alert('Export saved', 'Google Drive folder: ' + CFG.EXPORTS + '/' + f.getName() +
    '\nDownload it, change the path in TBDM_import.sps, and run it in SPSS.', SpreadsheetApp.getUi().ButtonSet.OK);
}
function tableMatrix_(ss, name, width) {
  const sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 1) return [];
  const vals = sh.getRange(1, 1, sh.getLastRow(), width).getDisplayValues();
  return vals.filter(function (r, i) { return i === 0 || r.some(function (v) { return String(v).trim() !== ''; }); });
}
function exportSnapshot_(ss, why) {
  const P = props_(), base = DriveApp.getFolderById(P.getProperty('FOLDER_ID'));
  const it = base.getFoldersByName(CFG.EXPORTS), exp = it.hasNext() ? it.next() : base.createFolder(CFG.EXPORTS);
  const f = exp.createFolder(Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd_HHmm') + '_' + why);
  const manifest = [['file', 'rows', 'sha256']];
  const put = function (name, matrix) {
    if (!matrix.length) return;
    const csv = matrix.map(function (r) { return r.map(csvField_).join(','); }).join('\r\n') + '\r\n';
    f.createFile(name, csv, MimeType.CSV);
    manifest.push([name, String(matrix.length - 1), sha256_(csv)]);
  };
  SCHEMA.forEach(function (t) { put(t.tab + '.csv', tableMatrix_(ss, t.tab, t.cols.length)); });
  Object.keys(DERIVED).forEach(function (n) { put(n + '.csv', tableMatrix_(ss, n, DERIVED[n].length)); });
  put('ALERTS.csv', tableMatrix_(ss, 'ALERTS', ALERT_SPEC.length));
  put('CODEBOOK.csv', tableMatrix_(ss, 'CODEBOOK', 7));
  [1, 2].forEach(function (r) {
    const id = P.getProperty('READER' + r + '_ID');
    if (id) put('CXR_Reader' + r + '.csv', tableMatrix_(SpreadsheetApp.openById(id), READER.tab, READER.cols.length));
  });
  const sps = spssSyntax_();
  f.createFile('TBDM_import.sps', sps, MimeType.PLAIN_TEXT);
  manifest.push(['TBDM_import.sps', '', sha256_(sps)]);
  f.createFile('MANIFEST.csv', manifest.map(function (r) { return r.map(csvField_).join(','); }).join('\r\n') + '\r\n', MimeType.CSV);
  logAudit_('EXPORT', '', '', '', f.getName(), 'snapshot exported (' + why + ')', 'system');
  return f;
}

// ---------------------------------------------------------------- withdrawal (protocol Section 12; form E4)
function clearRows_(ss, t, sid, keepLine) {
  const sh = ss.getSheetByName(t.tab), k = t.cols.map(function (c) { return c.key; }).indexOf('study_id') + 1;
  if (!sh || k < 1 || sh.getLastRow() < 2) return 0;
  let n = 0;
  sh.getRange(2, k, sh.getLastRow() - 1, 1).getDisplayValues().forEach(function (row, i) {
    if (String(row[0]).trim().toUpperCase() !== sid) return;
    if (keepLine) sh.getRange(i + 2, k).clearContent(); else sh.getRange(i + 2, 1, 1, t.cols.length).clearContent();
    n++;
  });
  return n;
}
function deleteRowsWhere_(sh, key, sid) {
  if (!sh || sh.getLastRow() < 2) return 0;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0], k = head.indexOf(key) + 1;
  if (k < 1) return 0;
  const v = sh.getRange(2, k, sh.getLastRow() - 1, 1).getDisplayValues();
  let n = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    if (String(v[i][0]).toUpperCase().split(' ').indexOf(sid) >= 0) { sh.deleteRow(i + 2); n++; }
  }
  return n;
}
function purgeAudit_(sid) {
  const sh = auditSS_().getSheetByName('LOG');
  if (sh.getLastRow() < 2) return 0;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getDisplayValues();
  let n = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    const ids = String(v[i][4]).toUpperCase().split(' ').filter(function (s) { return s !== ''; });
    if (ids.indexOf(sid) < 0) continue;
    if (ids.length === 1) sh.deleteRow(i + 2);
    else sh.getRange(i + 2, 5, 1, 3).setValues([[ids.filter(function (s) { return s !== sid; }).join(' '), '', '(content removed after the withdrawal of a participant)']]);
    n++;
  }
  return n;
}
function upsertEnd_(ss, sid, status, retention) {
  const sh = ss.getSheetByName('END_STUDY'), hit = readTab_(ss, defOf_('END_STUDY')).filter(function (r) { return r.study_id === sid; })[0];
  sh.getRange(hit ? hit._row : sh.getLastRow() + 1, 1, 1, 5).setValues([[sid, status, todayIso_(), retention, 'PI']]);
}
function logDeletion_(sid, action) {
  try { auditSS_().getSheetByName('DELETIONS').appendRow([new Date(), sid, action, me_(), '']); } catch (e) { console.error('logDeletion_: ' + e); }
}
function menuWithdraw() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), ss = dataSS_(), P = props_();
  const a = ui.prompt('Withdraw a participant', 'Study number, for example ' + idOf_(12) + ':', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const sid = a.getResponseText().trim().toUpperCase();
  if (!idOk_(sid) || !readTab_(ss, defOf_('S1_ENROL')).some(function (r) { return r.study_id === sid; })) {
    ui.alert('Not found', sid + ' is not in S1_ENROL. Nothing was changed.', ui.ButtonSet.OK);
    return;
  }
  const b = ui.prompt("Participant's choice", 'R = keep the data collected so far and collect nothing more.\nD = destroy all of this participant\'s data.\n\nType R or D:', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const ch = b.getResponseText().trim().toUpperCase();
  if (ch === 'R') {
    upsertEnd_(ss, sid, 'W', 'R');
    logAudit_('END_STUDY', '', sid, '', 'W, data kept', 'withdrawal recorded', '');
    logDeletion_(sid, 'withdrawn; data kept to the date of withdrawal');
    refreshAll();
    ui.alert('Withdrawal recorded', sid + ' is withdrawn. Data collected so far are kept; collect nothing more. Complete form E4 on paper.', ui.ButtonSet.OK);
    return;
  }
  if (ch !== 'D') { ui.alert('Nothing changed', 'Please answer R or D.', ui.ButtonSet.OK); return; }
  const sure = ui.alert('Destroy all data for ' + sid + '?', 'This clears every row for ' + sid + ' in every tab and both reader files, ' +
    'deletes its alerts and audit entries, and moves earlier exports to the Drive bin. It cannot be undone.', ui.ButtonSet.YES_NO);
  if (sure !== ui.Button.YES) return;
  let n = 0;
  SCHEMA.forEach(function (t) { n += clearRows_(ss, t, sid, t.tab === 'S0_SCREEN'); });
  [1, 2].forEach(function (r) { const id = P.getProperty('READER' + r + '_ID'); if (id) n += clearRows_(SpreadsheetApp.openById(id), READER, sid, false); });
  n += deleteRowsWhere_(ss.getSheetByName('ALERTS'), 'study_id', sid);
  if (P.getProperty('PHOTO_FOLDER_ID')) n += photoDeleteFor_(sid, 'withdrawal, destroy chosen', me_());   // before the audit purge, so its log line goes too
  n += purgeAudit_(sid);
  upsertEnd_(ss, sid, 'W', 'D');
  const base = DriveApp.getFolderById(P.getProperty('FOLDER_ID')), it = base.getFoldersByName(CFG.EXPORTS);
  if (it.hasNext()) { const sub = it.next().getFolders(); while (sub.hasNext()) sub.next().setTrashed(true); }
  refreshAll();
  exportSnapshot_(ss, 'after_withdrawal');
  logDeletion_(sid, 'withdrawn; all data destroyed (' + n + ' rows); earlier exports moved to the Drive bin');
  const notes = integrityCheck_(ss).filter(function (x) { return x.indexOf('fell') < 0; });
  ui.alert('Data destroyed', n + ' rows were cleared or deleted for ' + sid + '. The anonymous screening line is kept for the flow diagram without its study number.\n\n' +
    'Finish today, by hand (form E4, Part B):\n2. Empty the Google Drive bin.\n3. Delete every downloaded copy of an earlier export, including the copy on the encrypted drive.\n' +
    '4. Destroy the linking-log entry.\n5. Shred the core file and the signed consent form, apart from form E4, and countersign E4.' +
    (notes.length ? '\n\nIntegrity notes: ' + notes.join('; ') : ''), ui.ButtonSet.OK);
}

// ============================================================================
//  PHONE APP API (v1.1). The offline phone app (TBDM Field App) stores entries on the
//  phone, encrypted, and sends them here when online. Deploy this project once as a web
//  app: Deploy > New deployment > Web app; Execute as: Me; Who has access: Anyone. Every
//  request must carry a personal device token issued by the PI; without one nothing is read
//  or written. Writes are checked against exactly the same rules as typing in the sheet,
//  are logged in the audit log under the person's own e-mail, and raise the same alerts.
// ============================================================================
const APP_KEYS = {                     // how a row is identified for each tab
  S0_SCREEN: ['screen_no'], S1_ENROL: ['study_id'], S2_BASELINE: ['study_id'], S3_CXR: ['study_id'],
  LABS: ['study_id', 'visit'], VISITS: ['study_id', 'visit'], SPIRO: ['study_id'], PHQ_GAD: ['study_id', 'visit'],
  EVENTS: ['event_no'], END_STUDY: ['study_id'], QC_LOG: ['qc_no'], R_SCORES: ['study_id', 'read_no']
};
// The measurement nurse (role 'nurse') can see and write ONLY these tabs and ONLY these columns. null means every column.
// The server enforces it on every pull and push; the phone merely hides what the server would refuse anyway.
// To widen or narrow the role, change this list and publish; nothing else needs to change.
const NURSE_SCOPE = {
  S0_SCREEN: null,
  S1_ENROL: ['study_id', 'enrol_date', 'att_start_date', 'age_years', 'sex', 'residence', 'education', 'smoking', 'alcohol', 'pack_years', 'htn', 'optout_questionnaires', 'optout_spirometry', 'entered_by'],
  S2_BASELINE: ['study_id', 'exam_date', 'height_cm', 'weight_kg', 'waist_cm', 'muac_mm', 'examined_by'],
  VISITS: ['study_id', 'visit', 'visit_date', 'weight_kg', 'waist_cm', 'muac_mm', 'entered_by']
};
const NURSE_VISITS = ['V3', 'V5'];                    // follow-up visits at which the nurse measures
function nurseCol_(tab, key) { const s = NURSE_SCOPE[tab]; return s !== undefined && (s === null || s.indexOf(key) >= 0); }
// ---- Role access: what each role may do, set by the PI in the phone's Role manager (script property ACCESS).
// The PI always has everything except scoring films; the two readers only score films (blinding). Both columns are fixed.
// Every other role takes the defaults below until the PI changes a tick. The server enforces each tick on every request;
// the phone only hides what the server would refuse anyway. 'view' is the full clinical data: the ticks marked need: 'view' cannot be on without it.
const ACCESS_ROLES = ['data', 'qc', 'nurse', 'dots'];
const ACCESS_ROLE_NAMES = { pi: 'PI', data: 'Data entry', qc: 'Verifier', nurse: 'Nurse', dots: 'DOTS incharge', reader: 'Readers' };
const ACCESS_KEYS = [
  { key: 'screen', label: 'Screen and enrol' },
  { key: 'view', label: 'Participants, forms and summaries (full clinical data)' },
  { key: 'forms', label: 'Enter clinical forms (exam, labs, PHQ-9, visits)', need: 'view' },
  { key: 'measure', label: 'Enter measurements (height, weight, waist, arm)' },
  { key: 'due', label: 'Due and overdue', need: 'view' },
  { key: 'queries', label: 'Queries', need: 'view' },
  { key: 'checklist', label: 'Visit checklist' },
  { key: 'numbers', label: 'Give study numbers (Link register)' },
  { key: 'ident', label: 'Names, MRN, telephone (in the Link register)', confidential: true },
  { key: 'contacts', label: 'Call or WhatsApp participants (Contacts)', need: 'ident', confidential: true },
  { key: 'verify', label: 'Verification log', need: 'view' },
  { key: 'export', label: 'Export data', need: 'view' },
  { key: 'photoTake', label: 'Take document photos' },
  { key: 'photoView', label: 'Open document photos' }
];
const ACCESS_DEFAULT = {
  data: { screen: true, view: true, forms: true, measure: true, due: true, queries: true, checklist: true, photoTake: true },
  qc: { view: true, due: true, queries: true, checklist: true, verify: true, photoTake: true, photoView: true },
  nurse: { screen: true, measure: true, photoTake: true },
  dots: { numbers: true, ident: true, photoTake: true, photoView: true }
};
// One role's ticks: the defaults, overlaid with what the PI saved, with every tick that needs 'view' turned off when 'view' is off.
// Roles the PI adds in the Role manager ('c1', 'c2' ...) for particular people: a name, the people's e-mails and their own ticks (none by default).
const CUSTOM_ROLE_RX = /^c\d{1,3}$/, CUSTOM_MAX = 12, CUSTOM_PEOPLE_MAX = 20;
function isCustomRole_(role) { return CUSTOM_ROLE_RX.test(String(role || '')); }
function accessRoleName_(role, stored) {
  if (isCustomRole_(role)) { const c = stored && stored.custom && stored.custom[role]; return c ? String(c.name) : 'Removed role'; }
  return ACCESS_ROLE_NAMES[role] || (/^reader/.test(role) ? 'Radiograph reader' : String(role || ''));
}
function accessFor_(role, stored) {
  const out = {};
  if (role === 'pi') { ACCESS_KEYS.forEach(function (k) { out[k.key] = true; }); return out; }
  const custom = isCustomRole_(role) && stored && stored.custom && stored.custom[role] ? stored.custom[role] : null;
  if (ACCESS_ROLES.indexOf(role) < 0 && !custom) { ACCESS_KEYS.forEach(function (k) { out[k.key] = false; }); return out; }   // readers and unknown roles
  const d = custom ? {} : ACCESS_DEFAULT[role] || {}, sv = custom ? custom.access || {} : stored && stored[role] ? stored[role] : null;
  ACCESS_KEYS.forEach(function (k) { out[k.key] = sv && typeof sv[k.key] === 'boolean' ? sv[k.key] : !!d[k.key]; });
  ACCESS_KEYS.forEach(function (k) { if (k.need && !out[k.need]) out[k.key] = false; });
  return out;
}
// Can a role with these ticks write in this tab? Without 'forms' the measurement and enrolment tabs are limited to the NURSE_SCOPE columns.
function accessWriteTab_(role, a, tab) {
  if (role === 'pi') return tab !== 'R_SCORES';
  if (role === 'reader1' || role === 'reader2') return tab === 'R_SCORES';
  if (tab === 'R_SCORES') return false;
  if (tab === 'QC_LOG') return !!a.verify;
  if (tab === 'S0_SCREEN') return !!(a.screen || a.forms);
  if (tab === 'S1_ENROL') return !!(a.screen || a.forms);
  if (tab === 'S2_BASELINE' || tab === 'VISITS') return !!(a.forms || a.measure);
  return !!a.forms;
}
function accessLimited_(role, a) { return role !== 'pi' && !/^reader/.test(role) && !a.forms; }   // writes limited to NURSE_SCOPE columns
const APP_SERIAL = { S0_SCREEN: 'screen_no', EVENTS: 'event_no', QC_LOG: 'qc_no' };   // numbered by the server
const APP_JOIN_DAYS = 7;

function appJson_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function randomHex_(n) { let s = ''; while (s.length < n) s += Utilities.getUuid().replace(/-/g, ''); return s.slice(0, n); }
function roleOf_(email) {
  const e = (email || '').toLowerCase();
  if (e && e === piEmail_()) return 'pi';
  const cu = (accessStored_().custom) || {};                // a role the PI made for particular people comes before the standard lists
  const hit = Object.keys(cu).filter(function (id) { return isCustomRole_(id) && (cu[id].emails || []).indexOf(e) >= 0; })[0];
  if (e && hit) return hit;
  if (emails_('DATA_EMAILS').indexOf(e) >= 0) return 'data';
  if (emails_('QC_EMAILS').indexOf(e) >= 0) return 'qc';
  if (emails_('READER1_EMAIL').indexOf(e) >= 0) return 'reader1';
  if (emails_('READER2_EMAIL').indexOf(e) >= 0) return 'reader2';
  if (emails_('DOTS_EMAILS').indexOf(e) >= 0) return 'dots';
  if (emails_('NURSE_EMAILS').indexOf(e) >= 0) return 'nurse';
  return '';
}
function appUser_(token) {                    // the token's owner, if they still hold a study role
  if (!/^[0-9a-f]{64}$/.test(str_(token))) return null;
  const raw = props_().getProperty('APP_' + sha256_(token));
  if (!raw) return null;
  const u = JSON.parse(raw), role = roleOf_(u.email);
  if (!role) return null;
  u.role = role;
  return u;
}
function accessStored_() { try { const v = JSON.parse(props_().getProperty('ACCESS') || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
function userAccess_(u) { return accessFor_(u ? u.role : '', accessStored_()); }
function canWriteTab_(role, tab) { return accessWriteTab_(role, accessFor_(role, accessStored_()), tab); }   // kept for older callers
function appTarget_(role, tab) {              // [spreadsheet, definition] the change goes to
  const P = props_();
  if (tab === 'R_SCORES') return [SpreadsheetApp.openById(P.getProperty(role === 'reader2' ? 'READER2_ID' : 'READER1_ID')), READER];
  return [dataSS_(), defOf_(tab)];
}
function sameValue_(a, b) {
  const x = num_(a), y = num_(b);
  if (x !== null && y !== null) return x === y;
  return str_(a).toUpperCase() === str_(b).toUpperCase();
}

function doGet() { return appJson_({ ok: true, system: 'TBDM', version: CFG.VERSION }); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e && e.postData ? e.postData.contents : '{}'); } catch (err) { return appJson_({ ok: false, error: 'bad request' }); }
  try {
    if (req.op === 'join') return appJson_(appJoin_(req));
    const u = appUser_(req.token);
    if (!u) return appJson_({ ok: false, error: 'not authorised', code: 401 });
    if (req.op === 'hello') return appJson_({ ok: true, schema: wbSchema_(), version: CFG.VERSION });
    if (wbSchema_() !== CFG.SCHEMA_VER) return appJson_({ ok: false, error: 'The study workbook is being upgraded. Your entries are kept on this phone and are sent after the upgrade.', code: 409 });
    if (req.op === 'register_list') return appJson_(regList_(u));
    if (req.op === 'register_add') return appJson_(regAdd_(u, req));
    if (req.op === 'numbers_block') return appJson_(numbersBlock_(u, req));
    if (req.op === 'link_get') return appJson_(linkGet_(u, req));
    if (req.op === 'link_set') return appJson_(linkSet_(u, req));
    if (req.op === 'photo_put') return appJson_(photoPut_(u, req));
    if (req.op === 'photo_list') return appJson_(photoList_(u, req));
    if (req.op === 'photo_get') return appJson_(photoGet_(u, req));
    if (req.op === 'photo_flag') return appJson_(photoFlag_(u, req));
    if (req.op === 'pull') return appJson_(appPull_(u));
    if (req.op === 'access_set') return appJson_(accessSet_(u, req));
    if (req.op === 'nav_set') return appJson_(navSet_(u, req));
    if (req.op === 'push') {
      const theirs = req.schema === undefined ? 1 : Number(req.schema);   // apps older than the handshake send none
      if (theirs < CFG.SCHEMA_VER) return appJson_({ ok: false, error: 'This app is out of date. Close it and open it again while online.', code: 409 });
      if (theirs > CFG.SCHEMA_VER) return appJson_({ ok: false, error: 'The study workbook has not been upgraded yet. Your entries are kept on this phone.', code: 409 });
      return appJson_(appPush_(u, req.changes || []));
    }
    return appJson_({ ok: false, error: 'unknown operation' });
  } catch (err) {
    console.error('doPost: ' + (err && err.stack ? err.stack : err));
    return appJson_({ ok: false, error: 'server error: ' + (err && err.message ? err.message : err) });
  }
}

// A one-time join code (from the PI's invitation link) becomes a personal device token
function appJoin_(req) {
  const P = props_(), code = str_(req.code);
  if (!/^[0-9a-f]{32}$/.test(code)) return { ok: false, error: 'invalid invitation' };
  const k = 'APPJOIN_' + sha256_(code), raw = P.getProperty(k);
  if (!raw) return { ok: false, error: 'this invitation has already been used or was withdrawn' };
  const inv = JSON.parse(raw);
  P.deleteProperty(k);
  if (Date.now() > inv.expires) return { ok: false, error: 'this invitation has expired; ask the PI for a new one' };
  if (!roleOf_(inv.email)) return { ok: false, error: 'this account no longer has a study role' };
  const token = randomHex_(64);
  P.setProperty('APP_' + sha256_(token), JSON.stringify({ email: inv.email, issued: Date.now(), device: str_(req.device).slice(0, 60) }));
  logAudit_('APP', '', '', '', inv.email, 'phone app joined (' + str_(req.device).slice(0, 60) + ')', inv.email);
  return { ok: true, token: token, email: inv.email, role: roleOf_(inv.email) };
}

function appRows_(ss, def, cols) {
  return readTab_(ss, def).map(function (r) { return cols.map(function (k) { return r[k] === undefined ? '' : r[k]; }); });
}
function appPull_(u) {
  const out = { ok: true, email: u.email, role: u.role, version: CFG.VERSION, schema: CFG.SCHEMA_VER, serverTime: Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm'), today: todayIso_(), tabs: {}, photos: photosOn_() };
  const acc = userAccess_(u);
  out.access = acc;
  if (u.role === 'pi') out.accessStored = accessStored_();           // the Role manager grid on the PI phone
  out.roleName = accessRoleName_(u.role, accessStored_());
  { const no = navOrders_(); out.navOrder = no[navKey_(u.role)] || null; if (u.role === 'pi') out.navOrders = no; }
  if (!/^reader/.test(u.role) && !acc.view) {             // without the full clinical data: only the tabs its ticks need, and only their columns
    const nss = dataSS_(), want = {};
    if (acc.screen) { want.S0_SCREEN = 1; want.S1_ENROL = 1; }
    if (acc.measure) { want.S1_ENROL = 1; want.S2_BASELINE = 1; want.VISITS = 1; }
    if (acc.verify) want.QC_LOG = 1;
    SCHEMA.forEach(function (t) {
      if (!want[t.tab]) return;
      const cols = t.cols.map(function (c) { return c.key; }).filter(function (k) { return NURSE_SCOPE[t.tab] === undefined || nurseCol_(t.tab, k); });
      out.tabs[t.tab] = { cols: cols, rows: appRows_(nss, t, cols) };
    });
    return out;
  }
  if (u.role === 'reader1' || u.role === 'reader2') {
    const [rs, rdef] = appTarget_(u.role, 'R_SCORES'), cols = READER.cols.map(function (c) { return c.key; });
    out.tabs.R_SCORES = { cols: cols, rows: appRows_(rs, rdef, cols) };
    const imgs = {};                                         // which films have a covered radiograph photo the reader can open (photos switched on only)
    if (photosOn_()) { try { photoRows_(photoSheet_()).forEach(function (p) { if (photoVisible_(u, p)) { const k = str_(p.study_id); imgs[k] = imgs[k] || { n: 0, poor: false }; imgs[k].n++; imgs[k].poor = !!str_(p.flag); } }); } catch (e) { /* no photo index yet */ } }
    out.films = readTab_(dataSS_(), defOf_('S3_CXR')).filter(function (r) { return r.study_id; })
      .map(function (r) { const im = imgs[str_(r.study_id)]; return { study_id: r.study_id, cxr_date: r.cxr_date, repeat: r.repeat_read === 'Y', img: im ? im.n : 0, poor: im ? im.poor : false }; });
    return out;
  }
  const ss = dataSS_();
  SCHEMA.forEach(function (t) {
    let cols = t.cols.map(function (c) { return c.key; });
    out.tabs[t.tab] = { cols: cols, rows: appRows_(ss, t, cols) };
  });
  out.regnums = regNums_();
  out.held = heldBlocks_();
  return out;
}
// The PI's Role manager: saves the ticks for the four adjustable roles. Unknown roles or keys are ignored, every value must be true or false,
// and a tick that needs 'view' is saved off when 'view' is off. Each change is written to the audit log (role, tick, old and new value).
function accessSet_(u, req) {
  if (!u || u.role !== 'pi') return { ok: false, error: 'only the PI can change role access', code: 401 };
  const inc = req.access && typeof req.access === 'object' ? req.access : null;
  if (!inc) return { ok: false, error: 'nothing to save' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const old = accessStored_(), next = {}, changes = [];
    ACCESS_ROLES.forEach(function (r) {
      const before = accessFor_(r, old), src = inc[r] && typeof inc[r] === 'object' ? inc[r] : {}, row = {};
      ACCESS_KEYS.forEach(function (k) { row[k.key] = typeof src[k.key] === 'boolean' ? src[k.key] : before[k.key]; });
      ACCESS_KEYS.forEach(function (k) { if (k.need && !row[k.need]) row[k.key] = false; });
      next[r] = row;
      ACCESS_KEYS.forEach(function (k) { if (row[k.key] !== before[k.key]) changes.push(r + ' ' + k.key + ' ' + (before[k.key] ? 'on' : 'off') + ' to ' + (row[k.key] ? 'on' : 'off')); });
    });
    // roles made for particular people
    const oldC = old.custom || {}, incC = inc.custom && typeof inc.custom === 'object' ? inc.custom : oldC, seen = {}, pi = piEmail_();
    const ids = Object.keys(incC).filter(isCustomRole_);
    if (ids.length > CUSTOM_MAX) return { ok: false, error: 'at most ' + CUSTOM_MAX + ' extra roles' };
    next.custom = {};
    for (let n = 0; n < ids.length; n++) {
      const id = ids[n], c = incC[id] || {}, name = String(c.name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      if (!name) return { ok: false, error: 'every extra role needs a name' };
      const emails = (Array.isArray(c.emails) ? c.emails : []).map(function (x) { return String(x).trim().toLowerCase(); }).filter(function (x) { return x; });
      if (emails.length > CUSTOM_PEOPLE_MAX) return { ok: false, error: name + ': at most ' + CUSTOM_PEOPLE_MAX + ' people' };
      for (let m = 0; m < emails.length; m++) {
        const e = emails[m];
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, error: name + ': ' + e + ' is not an e-mail address' };
        if (e === pi) return { ok: false, error: name + ': the PI cannot be put in another role' };
        if (seen[e]) return { ok: false, error: e + ' is in two extra roles (' + seen[e] + ' and ' + name + ')' };
        seen[e] = name;
      }
      const before = oldC[id] ? accessFor_(id, old) : null, row = {}, src = c.access && typeof c.access === 'object' ? c.access : {};
      ACCESS_KEYS.forEach(function (k) { row[k.key] = typeof src[k.key] === 'boolean' ? src[k.key] : before ? before[k.key] : false; });
      ACCESS_KEYS.forEach(function (k) { if (k.need && !row[k.need]) row[k.key] = false; });
      next.custom[id] = { name: name, emails: emails, access: row };
      if (!oldC[id]) changes.push('new role ' + name + ' (' + emails.length + ' people)');
      else {
        if (oldC[id].name !== name) changes.push('role ' + oldC[id].name + ' renamed ' + name);
        if ((oldC[id].emails || []).join(',') !== emails.join(',')) changes.push(name + ' people: ' + emails.join(', '));
        ACCESS_KEYS.forEach(function (k) { if (row[k.key] !== before[k.key]) changes.push(name + ' ' + k.key + ' ' + (before[k.key] ? 'on' : 'off') + ' to ' + (row[k.key] ? 'on' : 'off')); });
      }
    }
    Object.keys(oldC).forEach(function (id) { if (!next.custom[id]) changes.push('role ' + oldC[id].name + ' removed'); });
    props_().setProperty('ACCESS', JSON.stringify(next));
    if (changes.length) logAudit_('ACCESS', '', '', '', '', 'role access changed: ' + changes.join('; '), u.email);
    return { ok: true, accessStored: next, changed: changes.length };
  } finally { lock.releaseLock(); }
}
// Default order of the bottom bar for each role, set by the PI by dragging the tabs while in Surveillance or Debugging as that role.
// A person who rearranges their own bar after that keeps their own order; the next change by the PI applies again.
const NAV_IDS = ['home', 'participants', 'measure', 'due', 'queries', 'visits', 'films', 'linkpick', 'register', 'settings'];
function navKey_(role) { return /^reader/.test(String(role || '')) ? 'reader' : String(role || ''); }
function navOrders_() { try { const v = JSON.parse(props_().getProperty('NAV_ORDER') || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
function navSet_(u, req) {
  if (!u || u.role !== 'pi') return { ok: false, error: 'only the PI can set the bar order', code: 401 };
  const key = navKey_(req.role);
  if (!(ACCESS_ROLES.indexOf(key) >= 0 || key === 'reader' || (isCustomRole_(key) && (accessStored_().custom || {})[key]))) return { ok: false, error: 'unknown role' };
  const order = (Array.isArray(req.order) ? req.order : []).map(function (x) { return String(x); });
  if (!order.length || order.length > NAV_IDS.length || order.some(function (x, i) { return NAV_IDS.indexOf(x) < 0 || order.indexOf(x) !== i; })) return { ok: false, error: 'not a valid bar order' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const all = navOrders_(); all[key] = { order: order, at: new Date().getTime() };
    props_().setProperty('NAV_ORDER', JSON.stringify(all));
    logAudit_('ACCESS', '', '', '', '', 'bar order for ' + accessRoleName_(key === 'reader' ? 'reader1' : key, accessStored_()) + ': ' + order.join(', '), u.email);
    return { ok: true, navOrders: all };
  } finally { lock.releaseLock(); }
}
function regNums_() {                                       // study numbers and outcome only, no names or contact details: lets Enrol offer a number the register has already given out
  try {
    if (!props_().getProperty('REGISTER_ID')) return [];
    return regRows_(regSheet_()).filter(function (r) { return idOk_(str_(r.study_id).toUpperCase()); }).map(function (r) { return [str_(r.study_id).toUpperCase(), str_(r.status)]; });
  } catch (e) { return []; }
}

// ---------------------------------------------------------------- study numbers register
// A separate Google sheet, shared only with the PI and the DOTS incharge (REGISTER_ID). It holds
// study numbers, age, sex, dates and status. Record numbers and telephone numbers are added only through the
// confidential link (a separate tab, off until approved); otherwise they stay on paper in cabinet A. The phone never stores this list: it is online only.
const REG_TAB = 'REGISTER';
// One tab, one row per study number. The first six columns are the numbers register; the last eight are the confidential link
// (record number, telephone, father or husband, name, address, note), filled only while the link switch is on.
const REG_COLS = ['study_id', 'assigned_date', 'assigned_by', 'status', 'reason', 'rid', 'mrn', 'phone', 'guardian', 'name', 'address', 'note', 'updated', 'updated_by'];
const REG_STATUS = [['E', 'enrolled'], ['D', 'declined'], ['S', 'spoiled']];
function regAllowed_(u) { if (!u) return false; if (u.role === 'pi') return true; const a = userAccess_(u); return !!(a.numbers || a.ident); }
function identAllowed_(u) { return !!u && (u.role === 'pi' || !!userAccess_(u).ident); }
function regSheet_() {
  const id = props_().getProperty('REGISTER_ID');
  if (!id) throw new Error('The numbers register is not set up yet.');
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(REG_TAB) || ss.insertSheet(REG_TAB);
  if (sh.getLastRow() === 0) { sh.appendRow(REG_COLS); sh.getRange(1, 7, sh.getMaxRows(), 2).setNumberFormat('@'); }   // keep leading zeros in record number and telephone
  else if (str_(sh.getRange(1, 2).getValue()) !== REG_COLS[1]) sh = regMigrate_(ss, sh);      // an older two-tab layout: merge it once
  return sh;
}
function regMigrate_(ss, old) {                          // old REGISTER (age, sex ...) and LINKING tabs become one REGISTER tab; the old tabs are kept, renamed, until the PI deletes them
  const ov = old.getDataRange().getValues(), oh = ov[0].map(function (h) { return str_(h); });
  const lk = ss.getSheetByName('LINKING'), lv = lk ? lk.getDataRange().getValues() : [], links = {};
  for (let i = 1; i < lv.length; i++) if (str_(lv[i][0]) !== '') links[str_(lv[i][0]).toUpperCase()] = { mrn: str_(lv[i][1]), phone: str_(lv[i][2]), address: str_(lv[i][3]), note: str_(lv[i][4]), updated: regDate_(lv[i][5]), updated_by: str_(lv[i][6]), guardian: str_(lv[i][7]), name: str_(lv[i][8]) };
  old.setName('OLD_REGISTER_delete_after_checking');
  if (lk) lk.setName('OLD_LINKING_delete_after_checking');
  const sh = ss.insertSheet(REG_TAB), out = [], seen = {};
  const get = function (r, k) { const j = oh.indexOf(k); return j < 0 ? '' : r[j]; };
  for (let i = 1; i < ov.length; i++) {
    const sid = str_(ov[i][0]).toUpperCase(); if (!sid) continue;
    const l = links[sid] || {}; seen[sid] = true;
    out.push([sid, regDate_(get(ov[i], 'assigned_date')), str_(get(ov[i], 'assigned_by')), str_(get(ov[i], 'status')), str_(get(ov[i], 'reason')), str_(get(ov[i], 'rid')), l.mrn || '', l.phone || '', l.guardian || '', l.name || '', l.address || '', l.note || '', l.updated || '', l.updated_by || '']);
  }
  Object.keys(links).forEach(function (sid) {            // a link saved for a number that had no register row
    if (seen[sid]) return; const l = links[sid];
    out.push([sid, l.updated || '', l.updated_by || '', 'E', '', '', l.mrn, l.phone, l.guardian, l.name, l.address, l.note, l.updated, l.updated_by]);
  });
  sh.getRange(1, 1, 1, REG_COLS.length).setValues([REG_COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, 7, sh.getMaxRows(), 2).setNumberFormat('@');
  if (out.length) sh.getRange(2, 1, out.length, REG_COLS.length).setValues(out);
  const first = ss.getSheets()[0]; if (first.getName() !== REG_TAB) ss.setActiveSheet(sh);
  logAudit_('REGISTER', '', '', '', '', 'register and link tabs merged into one (' + out.length + ' rows); old tabs kept, renamed', 'system');
  return sh;
}
function regDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : str_(v); }
function regRows_(sh) {
  const v = sh.getDataRange().getValues();
  if (v.length < 2) return [];
  const head = v[0].map(function (h) { return str_(h); });
  return v.slice(1).filter(function (r) { return str_(r[0]) !== ''; }).map(function (r) {
    const o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o;
  });
}
function regUsed_(sh) {                                  // every number in use: the register and the workbook's enrolment tab
  const used = {};
  regRows_(sh).forEach(function (r) { used[str_(r.study_id).toUpperCase()] = true; });
  readTab_(dataSS_(), defOf_('S1_ENROL')).forEach(function (r) { if (r.study_id) used[str_(r.study_id).toUpperCase()] = true; });
  return used;
}
function regNext_(used) {
  let top = 0;
  Object.keys(used).forEach(function (k) { if (idOk_(k)) top = Math.max(top, +k.slice(CFG.ID_PREFIX.length)); });
  return Math.max(top, blocksTop_()) + 1;               // never inside a block that a phone is holding
}

// ---------------------------------------------------------------- number blocks for phones
// A phone that is offline cannot know which number another phone has just taken. So each phone is handed its own
// block of consecutive numbers while it is online, and offers only those numbers when it has no signal. The blocks
// are kept one per script property (NUMBER_BLOCK_<first number>, each {from, to, dev, email, rid, at}), because Google caps
// one property value at about 9 KB and a single list would pass that after roughly 60 blocks. A number typed from the patient's card is
// still accepted anywhere, even inside someone else's block: the card is the source of the number.
const BLOCK_PREFIX = 'NUMBER_BLOCK_';
function blocksRead_() {
  const all = props_().getProperties(), out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(BLOCK_PREFIX) !== 0) return;
    try { const b = JSON.parse(all[k]); if (b && +b.from > 0 && +b.to >= +b.from) out.push(b); } catch (e) { /* a damaged entry is ignored, never fatal */ }
  });
  return out.sort(function (a, b) { return a.from - b.from; });
}
function heldBlocks_() {                                  // ranges handed to phones and the day they were handed out; lets the skipped-number check leave them alone for a while
  try { return blocksRead_().map(function (b) { return { from: +b.from, to: +b.to, day: Utilities.formatDate(new Date(+b.at || 0), CFG.TZ, 'yyyy-MM-dd') }; }); } catch (e) { return []; }
}
function blocksTop_() { return blocksRead_().reduce(function (m, b) { return Math.max(m, +b.to || 0); }, 0); }
function blocksAllUsed_() {                              // every number in the enrolment tab, the screening tab and the register
  const used = {};
  [['S1_ENROL'], ['S0_SCREEN']].forEach(function (p) {
    readTab_(dataSS_(), defOf_(p[0])).forEach(function (r) { if (r.study_id) used[str_(r.study_id).toUpperCase()] = true; });
  });
  if (props_().getProperty('REGISTER_ID')) regRows_(regSheet_()).forEach(function (r) { used[str_(r.study_id).toUpperCase()] = true; });
  return used;
}
function numbersBlock_(u, req) {
  if (!u || (u.role !== 'pi' && !(userAccess_(u).screen || userAccess_(u).numbers))) return { ok: false, error: 'not authorised', code: 401 };
  const rid = str_(req.rid), dev = str_(req.dev);
  if (!/^[0-9a-f]{8,64}$/i.test(rid) || !/^[0-9a-f]{8,64}$/i.test(dev)) return { ok: false, error: 'the request has no id; try again' };
  const mine = function (all) { return all.filter(function (b) { return b.dev === dev; }).map(function (b) { return { from: b.from, to: b.to }; }); };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const all = blocksRead_();
    if (all.some(function (b) { return b.rid === rid; })) return { ok: true, blocks: mine(all), again: true };           // a retry whose reply was lost: nothing new is reserved
    const last = all.filter(function (b) { return b.dev === dev; }).reduce(function (m, b) { return Math.max(m, +b.at || 0); }, 0);
    if (last && new Date().getTime() - last < 60000) return { ok: false, error: 'this phone was given numbers a moment ago; try again in a minute' };   // a fault on one phone must not use up the range
    const used = blocksAllUsed_();
    let top = blocksTop_();
    Object.keys(used).forEach(function (k) { if (idOk_(k)) top = Math.max(top, +k.slice(CFG.ID_PREFIX.length)); });
    const from = top + 1, n = Math.min(CFG.BLOCK_SIZE, CFG.ID_MAX - from + 1);
    if (n < 1) return { ok: false, error: 'all numbers up to ' + idOf_(CFG.ID_MAX) + ' are in use or held by phones' };
    const blk = { from: from, to: from + n - 1, dev: dev, email: u.email, rid: rid, at: new Date().getTime() };
    props_().setProperty(BLOCK_PREFIX + from, JSON.stringify(blk));
    all.push(blk);
    logAudit_('NUMBERS', '', '', '', idOf_(from) + ' to ' + idOf_(from + n - 1), 'study numbers held for one phone', u.email);
    return { ok: true, blocks: mine(all), again: false };
  } finally { lock.releaseLock(); }
}
function regList_(u) {
  if (!regAllowed_(u)) return { ok: false, error: 'not authorised', code: 401 };
  const sh = regSheet_(), on = linkOn_() && identAllowed_(u);     // names, record numbers and telephones only to a role ticked for them
  const rows = regRows_(sh).map(function (r) {
    const o = { study_id: str_(r.study_id), assigned_date: regDate_(r.assigned_date), status: str_(r.status), reason: str_(r.reason) };
    if (on) { o.mrn = str_(r.mrn); o.phone = str_(r.phone); o.name = str_(r.name); o.guardian = str_(r.guardian); o.address = str_(r.address); o.note = str_(r.note); o.updated = regDate_(r.updated); }   // the PI phone keeps an encrypted copy for offline use
    return o;
  });
  const have = {}; rows.forEach(function (o) { have[o.study_id.toUpperCase()] = true; });
  const extra = {};                                         // numbers with no register row (enrolled directly, or linked from the participant page) must still be found
  readTab_(dataSS_(), defOf_('S1_ENROL')).forEach(function (r) { if (r.study_id) extra[str_(r.study_id).toUpperCase()] = 'E'; });
  Object.keys(extra).sort().forEach(function (k) {
    if (have[k]) return;
    const o = { study_id: k, assigned_date: '', status: extra[k], reason: '' };
    if (on) { o.mrn = ''; o.phone = ''; o.name = ''; o.guardian = ''; o.address = ''; o.note = ''; o.updated = ''; }
    rows.push(o);
  });
  if (on) logAudit_('LINK_LIST', '', '', '', '', 'confidential register downloaded to ' + u.role + ' phone', u.email);   // values are never written to the audit log
  return { ok: true, rows: rows, next: idOf_(regNext_(regUsed_(sh))), today: todayIso_(), link: on };
}
function regAdd_(u, req) {
  if (!u || (u.role !== 'pi' && !userAccess_(u).numbers)) return { ok: false, error: 'not authorised', code: 401 };
  const lk = linkOn_() && identAllowed_(u);
  const status = code_(req.status), rid = str_(req.rid);
  const st = REG_STATUS.filter(function (p) { return p[0] === status; })[0];
  if (!st) return { ok: false, error: 'choose enrolled, declined or spoiled' };
  if (!/^[0-9a-f]{8,64}$/i.test(rid)) return { ok: false, error: 'the request has no id; try again' };
  const spoiled = status === 'S', reason = str_(req.reason).slice(0, 80);     // age and sex are not asked here: they are already in the enrolment form
  if (spoiled && !reason) return { ok: false, error: 'give the reason the number is spoiled' };
  const mrn = spoiled ? '' : str_(req.mrn).slice(0, 30), phone = spoiled ? '' : str_(req.phone).replace(/[\s\-()]/g, ''), name = spoiled ? '' : str_(req.name).slice(0, 60);
  const guardian = spoiled ? '' : str_(req.guardian).slice(0, 60), address = spoiled ? '' : str_(req.address).slice(0, 200);
  const wanted = code_(req.study_id);                     // the number printed on the patient's card; blank means the next free number
  if (wanted && !idOk_(wanted)) return { ok: false, error: 'the card number must look like ' + idOf_(7) + ' (' + idOf_(1) + ' to ' + idOf_(CFG.ID_MAX) + ')' };
  if ((mrn || phone || name || guardian || address) && !lk) return { ok: false, error: linkOn_() ? 'your role cannot record names, record numbers or telephones' : 'name, record number and telephone can be saved only while the confidential link is switched on' };
  if (!spoiled && lk && (!name.trim() || !mrn || !phone)) return { ok: false, error: 'the participant name, the record number and the telephone number are all required' };
  if (phone && !/^\+?\d{7,15}$/.test(phone)) return { ok: false, error: 'telephone: digits only, 7 to 15 of them, e.g. 03001234567' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = regSheet_();
    const again = regRows_(sh).filter(function (r) { return str_(r.rid) === rid; })[0];
    if (again) {                                          // a retry: finish the link row if the first try stopped before writing it
      const aid = str_(again.study_id).toUpperCase();
      const af = regFind_(sh, aid);
      if ((mrn || phone) && af && !str_(af.o.mrn) && !str_(af.o.phone)) { regLinkWrite_(sh, af.row, { mrn: mrn, phone: phone, guardian: guardian, name: name, address: address, note: '' }, u.email); logAudit_('LINK_SAVE', '', aid, '', '', 'confidential link created', u.email); }
      return { ok: true, study_id: str_(again.study_id), again: true };
    }
    const used = regUsed_(sh);
    let id;
    if (wanted) {                                         // the number printed on the patient's card
      if (used[wanted]) return { ok: false, error: wanted + ' is already in use. Check the card.' };
      id = wanted;
    } else {
      const n = regNext_(used);
      if (n > CFG.ID_MAX) return { ok: false, error: 'all numbers up to ' + idOf_(CFG.ID_MAX) + ' are in use' };
      id = idOf_(n);
    }
    sh.appendRow([id, todayIso_(), u.email, status, spoiled ? reason : '', rid, '', '', '', '', '', '', '', '']);
    logAudit_('REGISTER', '', id, '', st[1], 'study number assigned (' + st[1] + ')', u.email);
    if (mrn || phone) {                                    // only while the confidential link is on; the values are never written to the audit log
      regLinkWrite_(sh, sh.getLastRow(), { mrn: mrn, phone: phone, guardian: guardian, name: name, address: address, note: '' }, u.email);
      logAudit_('LINK_SAVE', '', id, '', '', 'confidential link created', u.email);
    }
    return { ok: true, study_id: id, again: false };
  } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- confidential link (PI and DOTS incharge)
// Medical record number, telephone number, address and a note for ONE study number, in a tab of the
// register file (REGISTER_ID), plus the participant's name and the name of a father or husband. Online only, never kept on the phone, and every
// view or change is written to the audit log (without the values). It is OFF until the PI switches it
// on with the menu item "PI: confidential link on or off", which must wait for ethics committee approval.
function linkOn_() { return props_().getProperty('LINK_ENABLED') === 'Y'; }
function regFind_(sh, sid) {                              // the one row of a study number, as an object
  const v = sh.getDataRange().getValues();
  if (v.length < 2) return null;
  const head = v[0].map(function (h) { return str_(h); });
  for (let i = 1; i < v.length; i++) if (str_(v[i][0]).toUpperCase() === sid) { const o = {}; head.forEach(function (h, k) { o[h] = v[i][k]; }); return { row: i + 1, o: o }; }
  return null;
}
function regLinkWrite_(sh, row, l, by) {                  // the link columns of one register row: mrn, phone, guardian, name, address, note, updated, updated_by
  sh.getRange(row, 7, 1, 8).setValues([[l.mrn, l.phone, l.guardian, l.name, l.address, l.note, todayIso_(), by]]);
}
function linkCheck_(u, req) {
  if (!identAllowed_(u)) return { ok: false, error: 'not authorised', code: 401 };
  if (!linkOn_()) return { ok: false, error: 'The confidential link is switched off.' };
  const sid = code_(req.study_id);
  if (!idOk_(sid)) return { ok: false, error: 'not a valid study number' };
  if (!regUsed_(regSheet_())[sid]) return { ok: false, error: 'this study number has not been assigned' };
  return { ok: true, sid: sid };
}
function linkGet_(u, req) {
  const c = linkCheck_(u, req); if (!c.ok) return c;
  const f = regFind_(regSheet_(), c.sid), o = f ? f.o : {};
  logAudit_('LINK_VIEW', '', c.sid, '', '', 'confidential link opened', u.email);
  return { ok: true, study_id: c.sid, mrn: str_(o.mrn), phone: str_(o.phone), address: str_(o.address), note: str_(o.note), guardian: str_(o.guardian), name: str_(o.name), updated: regDate_(o.updated) };
}
function linkSet_(u, req) {
  const c = linkCheck_(u, req); if (!c.ok) return c;
  const mrn = str_(req.mrn).slice(0, 30), address = str_(req.address).slice(0, 200), note = str_(req.note).slice(0, 200);
  const phone = str_(req.phone).replace(/[\s\-()]/g, ''), guardian = str_(req.guardian).slice(0, 60), name = str_(req.name).slice(0, 60);
  if (!mrn || !phone) return { ok: false, error: 'the record number and the telephone number are both required' };
  if (!/^\+?\d{7,15}$/.test(phone)) return { ok: false, error: 'telephone: digits only, 7 to 15 of them, e.g. 03001234567' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = regSheet_(), f = regFind_(sh, c.sid), had = !!(f && (str_(f.o.mrn) || str_(f.o.phone)));
    let row;
    if (f) row = f.row;
    else { sh.appendRow([c.sid, todayIso_(), u.email, 'E', '', '', '', '', '', '', '', '', '', '']); row = sh.getLastRow(); }   // a number linked from the participant page gets its register row here
    regLinkWrite_(sh, row, { mrn: mrn, phone: phone, guardian: guardian, name: name, address: address, note: note }, u.email);
    logAudit_('LINK_SAVE', '', c.sid, '', '', 'confidential link ' + (had ? 'changed' : 'created'), u.email);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function menuLinkSwitch() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_(), on = linkOn_();
  const a = ui.alert('Confidential link', 'It is now ' + (on ? 'ON' : 'OFF') + '. It holds record numbers, telephone numbers, addresses, the participant name and the name of a father or husband for the PI and the DOTS incharge, online only. Switch it ON only after the ethics committee has approved it and the consent form says so.\n\nSwitch it ' + (on ? 'OFF' : 'ON') + '?', ui.ButtonSet.YES_NO);
  if (a !== ui.Button.YES) return;
  P.setProperty('LINK_ENABLED', on ? 'N' : 'Y');
  logAudit_('LINK_SWITCH', '', '', on ? 'ON' : 'OFF', on ? 'OFF' : 'ON', 'confidential link switched', me_());
  ui.alert('The confidential link is now ' + (on ? 'OFF' : 'ON') + '.');
}

// ---------------------------------------------------------------- photos of source documents (off until the ethics committee approves)
// Any data role (and the DOTS incharge) can photograph a source document and attach it to a record: consent form, Core File,
// withdrawal record, PHQ-9 alert slip, lab report, spirometry printout, chest radiograph. Photos go to a private Drive folder
// owned by the PI (not inside the shared study folder), with one index row each in a PHOTOS tab of the register file. Phones that
// take a photo cannot view it afterwards. The PI, the verifier and the DOTS incharge can view; the radiograph readers see only
// radiographs whose name label was covered on the phone before upload. Every upload, view, flag and deletion is audited (never the image).
// Switched on with "PI: photos of documents on or off".
const PHOTO_TAB = 'PHOTOS';
const PHOTO_COLS = ['photo_id', 'study_id', 'doc', 'visit', 'covered', 'file_id', 'sha256', 'taken_at', 'taken_by', 'uploaded_at', 'flag', 'note', 'deleted'];
const PHOTO_DOCS = { CONSENT: 'consent form', CORE: 'Core Per-Patient File', EXAM: 'examination sheet', SMEAR: 'sputum smear report', LAB_CBC: 'lab report: blood count', LAB_LFT: 'lab report: liver tests', LAB_HBA1C: 'lab report: HbA1c', LAB_LIPID: 'lab report: lipid profile', LAB_FPG: 'lab report: fasting glucose', LAB_HEP: 'lab report: viral serology (HBsAg, anti-HCV)', LAB_HIV: 'lab report: HIV', WITHDRAW: 'Withdrawal Deletion Record', ALERT: 'PHQ-9 item 9 alert slip', LAB: 'lab report', SPIRO: 'spirometry printout', CXR: 'chest radiograph' };
const PHOTO_MAX = 4000000;                                // base64 characters, about 3 MB of image
const PHOTO_MAX_CXR = 40000000;                           // radiographs are exempt from compression and keep full resolution: up to about 30 MB of image
function photosOn_() { return props_().getProperty('PHOTOS_ENABLED') === 'Y'; }
function photoTakeRole_(u) { return !!u && (u.role === 'pi' || !!userAccess_(u).photoTake); }
function photoViewRole_(u) { return !!u && (u.role === 'pi' || !!userAccess_(u).photoView); }
function photoReader_(u) { return !!u && (u.role === 'reader1' || u.role === 'reader2'); }
function photoSheet_() {
  const id = props_().getProperty('REGISTER_ID');
  if (!id) throw new Error('The numbers register is not set up yet.');
  const ss = SpreadsheetApp.openById(id);
  const sh = ss.getSheetByName(PHOTO_TAB) || ss.insertSheet(PHOTO_TAB);
  if (sh.getLastRow() === 0) sh.appendRow(PHOTO_COLS);
  return sh;
}
function photoFolder_() {                                   // at the top of the PI's Drive, so it never inherits the study folder's sharing
  const P = props_(), id = P.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* make a new one */ } }
  const f = DriveApp.createFolder('TBDM photos of source documents (confidential, PI only)');
  P.setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}
function photoRows_(sh) {
  const v = sh.getDataRange().getValues(); if (v.length < 2) return [];
  const head = v[0].map(function (h) { return str_(h); });
  return v.slice(1).map(function (r, i) { const o = { _row: i + 2 }; head.forEach(function (h, k) { o[h] = r[k]; }); return o; });
}
function photoVisible_(u, r) {
  if (str_(r.deleted)) return false;
  if (photoViewRole_(u)) return true;
  return photoReader_(u) && str_(r.doc) === 'CXR' && str_(r.covered) === 'Y';
}
function bytesHex_(bytes) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function photoPut_(u, req) {
  if (!photoTakeRole_(u)) return { ok: false, error: 'not authorised', code: 401 };
  if (!photosOn_()) return { ok: false, error: 'Photos of documents are switched off.' };
  const pid = str_(req.photo_id).toLowerCase(), sid = code_(req.study_id), doc = code_(req.doc), visit = code_(req.visit), covered = code_(req.covered) === 'Y' ? 'Y' : 'N';
  if (!/^[0-9a-f]{32}$/.test(pid)) return { ok: false, error: 'bad photo id' };
  if (!idOk_(sid)) return { ok: false, error: 'not a valid study number' };
  if (!PHOTO_DOCS[doc]) return { ok: false, error: 'unknown document type' };
  if (visit && !/^(V[1-5]|U[1-5])$/.test(visit)) return { ok: false, error: 'unknown visit' };
  const mime = str_(req.mime);
  if (['image/jpeg', 'image/png'].indexOf(mime) < 0) return { ok: false, error: 'only JPEG or PNG images' };
  const data = String(req.data || '');
  if (!data || data.length > (doc === 'CXR' ? PHOTO_MAX_CXR : PHOTO_MAX)) return { ok: false, error: 'the image is empty or too large' };
  const bytes = Utilities.base64Decode(data), sha = bytesHex_(bytes);
  if (str_(req.sha256).toLowerCase() !== sha) return { ok: false, error: 'the image was damaged on the way; it will be sent again' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = photoSheet_();
    if (photoRows_(sh).some(function (r) { return str_(r.photo_id) === pid; })) return { ok: true, photo_id: pid, again: true };   // a retry of a photo already received
    const name = [sid, visit || '-', doc, covered === 'Y' ? 'covered' : 'original', pid.slice(0, 8)].join('_') + (mime === 'image/png' ? '.png' : '.jpg');
    const file = photoFolder_().createFile(Utilities.newBlob(bytes, mime, name));
    sh.appendRow([pid, sid, doc, visit, covered, file.getId(), sha, str_(req.taken_at).slice(0, 25), u.email, new Date().toISOString(), '', str_(req.note).slice(0, 200), '']);
    logAudit_('PHOTO_ADD', '', sid, '', '', PHOTO_DOCS[doc] + (visit ? ' ' + visit : '') + (covered === 'Y' ? ' (label covered)' : ''), u.email);
    return { ok: true, photo_id: pid };
  } finally { lock.releaseLock(); }
}
function photoList_(u, req) {
  if (!photoViewRole_(u) && !photoReader_(u) && !photoTakeRole_(u)) return { ok: false, error: 'not authorised', code: 401 };
  if (!photosOn_()) return { ok: true, photos: [], off: true };
  const sid = code_(req.study_id);
  if (!idOk_(sid)) return { ok: false, error: 'not a valid study number' };
  if (!photoViewRole_(u) && !photoReader_(u))               // a phone that only takes photos learns which documents exist, never the photos themselves
    return { ok: true, which: true, photos: photoRows_(photoSheet_()).filter(function (r) { return str_(r.study_id) === sid && !str_(r.deleted); }).map(function (r) { return { doc: str_(r.doc), visit: str_(r.visit) }; }) };
  const list = photoRows_(photoSheet_()).filter(function (r) { return str_(r.study_id) === sid && photoVisible_(u, r); })
    .map(function (r) { return { photo_id: str_(r.photo_id), doc: str_(r.doc), visit: str_(r.visit), covered: str_(r.covered), taken_at: str_(r.taken_at), taken_by: photoReader_(u) ? '' : str_(r.taken_by), flag: str_(r.flag) }; });
  return { ok: true, photos: list };
}
function photoGet_(u, req) {
  if (!photoViewRole_(u) && !photoReader_(u)) return { ok: false, error: 'not authorised', code: 401 };
  if (!photosOn_()) return { ok: false, error: 'Photos of documents are switched off.' };
  const pid = str_(req.photo_id).toLowerCase(), r = photoRows_(photoSheet_()).filter(function (x) { return str_(x.photo_id) === pid; })[0];
  if (!r || !photoVisible_(u, r)) return { ok: false, error: 'photo not found' };
  const blob = DriveApp.getFileById(str_(r.file_id)).getBlob();
  logAudit_('PHOTO_VIEW', '', str_(r.study_id), '', '', PHOTO_DOCS[str_(r.doc)] + (str_(r.visit) ? ' ' + str_(r.visit) : '') + ' photo opened', u.email);
  return { ok: true, photo_id: pid, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}
function photoFlag_(u, req) {                              // "too poor to read": the PI is told by e-mail
  if (!photoViewRole_(u) && !photoReader_(u)) return { ok: false, error: 'not authorised', code: 401 };
  const pid = str_(req.photo_id).toLowerCase(), lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = photoSheet_(), r = photoRows_(sh).filter(function (x) { return str_(x.photo_id) === pid; })[0];
    if (!r || !photoVisible_(u, r)) return { ok: false, error: 'photo not found' };
    sh.getRange(r._row, PHOTO_COLS.indexOf('flag') + 1).setValue('poor: ' + u.role + ' ' + todayIso_());
    logAudit_('PHOTO_FLAG', '', str_(r.study_id), '', 'poor', PHOTO_DOCS[str_(r.doc)] + ' photo marked too poor to read', u.email);
    notifyPI_('TB-DM study: photo too poor to read', str_(r.study_id) + ': the ' + PHOTO_DOCS[str_(r.doc)] + (str_(r.visit) ? ' (' + str_(r.visit) + ')' : '') + ' photo was marked too poor to read by ' + u.role + '. Please arrange a better photo or the original.');
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function menuPhotoSwitch() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_(), on = photosOn_();
  const a = ui.alert('Photos of documents', 'It is now ' + (on ? 'ON' : 'OFF') + '. Photos of consent forms, lab reports, radiographs and other source documents show names and record numbers. ' +
    'Switch it on only after the ethics committee has approved storing them.\n\nSwitch it ' + (on ? 'OFF' : 'ON') + '?', ui.ButtonSet.YES_NO);
  if (a !== ui.Button.YES) return;
  P.setProperty('PHOTOS_ENABLED', on ? 'N' : 'Y');
  if (!on) { photoFolder_(); photoSheet_(); }
  logAudit_('PHOTO_SWITCH', '', '', on ? 'ON' : 'OFF', on ? 'OFF' : 'ON', 'photos of documents switched', me_());
  ui.alert('Photos of documents are now ' + (on ? 'OFF. Photos already received are kept.' : 'ON. Phones show the photo buttons after their next sync.'));
}
function photoDeleteFor_(sid, why, by) {                  // the participant chose "destroy all data": every photo goes to the bin and its index row is marked
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let n = 0;
  try {
    const sh = photoSheet_();
    photoRows_(sh).forEach(function (r) {
      if (str_(r.study_id) !== sid || str_(r.deleted)) return;
      try { DriveApp.getFileById(str_(r.file_id)).setTrashed(true); } catch (e) { /* already gone */ }
      sh.getRange(r._row, PHOTO_COLS.indexOf('deleted') + 1).setValue(todayIso_() + ' ' + why);
      n++;
    });
    logAudit_('PHOTO_DELETE', '', sid, '', '', n + ' photo(s) deleted: ' + why, by);
  } finally { lock.releaseLock(); }
  return n;
}
function menuPhotoDelete() {
  requirePI_();
  const ui = SpreadsheetApp.getUi();
  const a = ui.prompt('Delete a participant\'s photos', 'Study number whose photos must be destroyed (for a withdrawal with the "destroy all data" choice):', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const sid = a.getResponseText().trim().toUpperCase();
  if (!idOk_(sid)) { ui.alert('Not a valid study number.'); return; }
  if (ui.alert('Delete photos of ' + sid + '?', 'Every photo of ' + sid + ' goes to the Drive bin. Empty the bin to destroy them for good.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const n = photoDeleteFor_(sid, 'withdrawal, destroy chosen', me_());
  ui.alert(n + ' photo(s) of ' + sid + ' deleted. Empty the Drive bin, and record this on the Withdrawal Deletion Record.');
}

// ---------------------------------------------------------------- erase all test data (PI only, practice before approval)
function clearBelowHeader_(sh, ncols) {
  if (!sh || sh.getLastRow() < 2) return 0;
  const n = sh.getLastRow() - 1;
  sh.getRange(2, 1, n, Math.max(1, Math.min(ncols || sh.getMaxColumns(), sh.getMaxColumns()))).clearContent();
  return n;
}
function menuEraseAll() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_(), ss = dataSS_();
  const a = ui.prompt('Erase ALL test data?', 'This clears every participant row in every data tab, both reader files, the numbers register, the alerts, the audit log and earlier exports. ' +
    'Headers, checks, users, invitations and settings are kept, and numbering starts again at ' + idOf_(1) + '.\n\nA backup copy of the files is saved in your Drive folder first.\n\nType ERASE to continue:', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK || a.getResponseText().trim() !== 'ERASE') { ui.alert('Nothing changed', 'The word ERASE was not typed.', ui.ButtonSet.OK); return; }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { ui.alert('Busy', 'The study is busy. Try again in a minute.', ui.ButtonSet.OK); return; }
  let n = 0;
  try {
    const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH-mm'), folderId = P.getProperty('FOLDER_ID');
    const folder = folderId ? DriveApp.getFolderById(folderId) : null, backups = [];
    ['DATA_ID', 'READER1_ID', 'READER2_ID', 'REGISTER_ID'].forEach(function (k) {         // backup first: if it fails, nothing is erased
      const id = P.getProperty(k); if (!id) return;
      const f = DriveApp.getFileById(id), name = 'BACKUP before erase ' + stamp + ' - ' + f.getName();
      backups.push(folder ? f.makeCopy(name, folder) : f.makeCopy(name));
    });
    SCHEMA.forEach(function (t) { n += clearBelowHeader_(ss.getSheetByName(t.tab), t.cols.length); });
    buildTab_(ss, defOf_('S1_ENROL'));                       // re-applies the drop-down lists, so a changed list of choices (the consent form answers) takes effect
    ['ALERTS', 'QC_LOG'].forEach(function (nm) { n += clearBelowHeader_(ss.getSheetByName(nm), 0); });
    [1, 2].forEach(function (r) { const id = P.getProperty('READER' + r + '_ID'); if (id) n += clearBelowHeader_(SpreadsheetApp.openById(id).getSheetByName(READER.tab), READER.cols.length); });
    const rid = P.getProperty('REGISTER_ID');
    if (rid) { const rs = SpreadsheetApp.openById(rid); rs.getSheets().forEach(function (sh) { n += clearBelowHeader_(sh, 0); });         }
    const pf = P.getProperty('PHOTO_FOLDER_ID');           // photos of test documents go to the bin with the rest
    if (pf) { try { const it = DriveApp.getFolderById(pf).getFiles(); while (it.hasNext()) it.next().setTrashed(true); } catch (e) { /* no folder */ } }   // the register tab and any old tab kept after the merge
    const au = auditSS_();
    ['LOG', 'SNAPSHOTS', 'APP_KEYS'].forEach(function (nm) { n += clearBelowHeader_(au.getSheetByName(nm), 0); });
    Object.keys(P.getProperties()).forEach(function (k) { if (k.indexOf(BLOCK_PREFIX) === 0) P.deleteProperty(k); });   // numbers held by phones: numbering restarts at TBDM-001
    if (folder) { const it = folder.getFoldersByName(CFG.EXPORTS); if (it.hasNext()) { const sub = it.next().getFolders(); while (sub.hasNext()) sub.next().setTrashed(true); } }
    logDeletion_('ALL', 'all test data erased (' + n + ' rows); backup copies made');
    logAudit_('ERASE_ALL', '', '', '', '', 'all test data erased; numbering restarts', me_());
  } finally { lock.releaseLock(); }
  refreshAll();                                             // after the lock is released: refreshAll takes the same lock
  {
    ui.alert('Clean start', n + ' rows were cleared. Backup copies (named BACKUP before erase) are in your study folder; delete them when you are sure, and empty the Drive bin.\n\n' +
      'Next, on every phone that was used for testing: open the app, press Sync, and clear any entry listed as needing a fix, before entering anything new.', ui.ButtonSet.OK);
  }
}

function appPush_(u, changes) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const results = [], touched = {};
  try {
    const ss = dataSS_(), today = dayNo_(todayIso_());
    const keysSheet = appKeySheet_();
    changes.slice(0, 200).forEach(function (ch) {
      try { results.push(appApply_(u, ch, ss, today, keysSheet, touched)); }
      catch (err) { results.push({ cid: ch && ch.cid, status: 'rejected', errors: { _: String(err && err.message ? err.message : err) } }); }
    });
  } finally { lock.releaseLock(); }
  const sids = Object.keys(touched);
  if (sids.length) { try { alertsFor_(dataSS_(), sids); } catch (err) { console.error('app alerts: ' + err); } }
  return { ok: true, results: results, serverTime: Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm') };
}
function appKeySheet_() {                    // client record id -> number the server gave it, so a resend never duplicates
  const a = auditSS_();
  let sh = a.getSheetByName('APP_KEYS');
  if (!sh) { sh = a.insertSheet('APP_KEYS'); sh.getRange(1, 1, 1, 4).setValues([['client_id', 'tab', 'number', 'by']]); }
  return sh;
}
// The screening outcome follows the answers. Phone and workbook use the same rule (field-app/src/app.js screenDerive).
function screenDerive_(m, vals) {
  if (code_(m.smear_grade) === 'N' && !str_(m.excl_code)) { m.excl_code = '8'; vals.excl_code = '8'; }   // sputum smear negative = exclusion 8
  if (str_(m.excl_code)) {
    ['eligible', 'enrolled', 'not_enrolled_reason'].forEach(function (k) { m[k] = k === 'not_enrolled_reason' ? '' : 'N'; vals[k] = m[k]; });
  }
}
function appApply_(u, ch, ss, today, keysSheet, touched) {
  const tab = str_(ch.tab), keys = APP_KEYS[tab];
  const acc = userAccess_(u);
  if (!keys || !accessWriteTab_(u.role, acc, tab)) return { cid: ch.cid, status: 'rejected', errors: { _: 'your role cannot write in ' + tab } };
  const tgt = appTarget_(u.role, tab), file = tgt[0], def = tgt[1], sh = file.getSheetByName(def.tab);
  const colKeys = def.cols.map(function (c) { return c.key; });
  const vals = ch.values || {}, base = ch.base || {};
  if (accessLimited_(u.role, acc) && (tab === 'S1_ENROL' || tab === 'S2_BASELINE' || tab === 'VISITS')) {   // without 'forms' only the measurement columns; enforced here, whatever the phone sends
    const outside = Object.keys(vals).filter(function (k) { return k[0] !== '_' && !nurseCol_(tab, k); });
    if (outside.length) return { cid: ch.cid, status: 'rejected', errors: { _: 'your role cannot enter ' + outside.join(', ') + ' in ' + tab } };
    if (tab === 'VISITS' && NURSE_VISITS.indexOf(str_(vals.visit).toUpperCase()) < 0) return { cid: ch.cid, status: 'rejected', errors: { _: 'your role can enter measurements at ' + NURSE_VISITS.join(' and ') + ' only' } };
  }
  const rows = readTab_(file, def), enrolled = {};
  readTab_(ss, defOf_('S1_ENROL')).forEach(function (r) { if (r.study_id) enrolled[r.study_id] = true; });
  if (tab === 'S1_ENROL' && vals.study_id) enrolled[code_(vals.study_id)] = true;
  const serial = APP_SERIAL[tab];
  let row = null, assigned = null;
  if (serial && !str_(vals[serial])) {                          // new numbered record made offline
    const cid = str_(ch.rid);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(cid)) return { cid: ch.cid, status: 'rejected', errors: { _: 'missing record id' } };
    const known = keysSheet.getLastRow() > 1 ? keysSheet.getRange(2, 1, keysSheet.getLastRow() - 1, 3).getDisplayValues().filter(function (r) { return r[0] === cid; })[0] : null;
    if (known) { assigned = num_(known[2]); row = rows.filter(function (r) { return num_(r[serial]) === assigned; })[0] || null; }
    else {
      assigned = rows.reduce(function (m, r) { return Math.max(m, num_(r[serial]) || 0); }, 0) + 1;
      keysSheet.appendRow([cid, tab, assigned, u.email]);
    }
    vals[serial] = String(assigned);
  } else {
    const want = keys.map(function (k) { return code_(vals[k]); });
    if (want.some(function (x) { return !x; })) return { cid: ch.cid, status: 'rejected', errors: { _: 'missing ' + keys.join(' and ') } };
    row = rows.filter(function (r) { return keys.every(function (k, i) { return code_(r[k]) === want[i]; }); })[0] || null;
    if (row && ch.create) {
      // a resend of a save that already reached the workbook (the reply was lost): report success, never a duplicate error
      const sent = keysSheet.getLastRow() > 1 ? keysSheet.getRange(2, 1, keysSheet.getLastRow() - 1, 3).getDisplayValues().filter(function (r) { return r[0] === str_(ch.cid) && r[1] === tab; })[0] : null;
      if (sent && sent[2] === want.join(' ')) { const again = {}; keys.forEach(function (k, i) { again[k] = want[i]; }); return { cid: ch.cid, status: 'ok', changed: 0, key: again, row: row._row, again: true }; }
      return { cid: ch.cid, status: 'conflict', errors: { _: keys.map(function (k) { return vals[k]; }).join(' ') + ' already exists in ' + tab + '. Open the existing record instead.' } };
    }
    if (!row && !ch.create) return { cid: ch.cid, status: 'conflict', errors: { _: 'this record no longer exists on the server (it may have been withdrawn). Not saved.' } };
  }
  const merged = {};
  colKeys.forEach(function (k) { merged[k] = row ? row[k] : ''; });
  Object.keys(vals).forEach(function (k) { if (colKeys.indexOf(k) >= 0) merged[k] = str_(vals[k]); });
  if (tab === 'S0_SCREEN') screenDerive_(merged, vals);                 // smear negative or an exclusion: not eligible, not enrolled
  if (tab === 'S1_ENROL' && !row) {                                     // one entry: age and sex are copied from the screening line
    const sid0 = code_(merged.study_id), sc = readTab_(ss, defOf_('S0_SCREEN')).filter(function (r) { return code_(r.study_id) === sid0; })[0];
    if (!sc) return { cid: ch.cid, status: 'rejected', errors: { _: 'there is no screening line for ' + sid0 + ' yet. Screen the patient first (sync the phone that did the screening if it has not been sent), then enrol' } };
    if (sc.eligible !== 'Y' || sc.enrolled !== 'Y') return { cid: ch.cid, status: 'rejected', errors: { _: 'the screening line for ' + sid0 + ' does not say eligible and enrolled, so there is no enrolment' } };
    if (sc && str_(sc.age) !== '') { merged.age_years = str_(sc.age); vals.age_years = merged.age_years; }
    if (sc && str_(sc.sex) !== '') { merged.sex = str_(sc.sex); vals.sex = merged.sex; }
  }
  const errors = {}, ctx = { enrolled: enrolled, today: today };
  if (def === READER) {                                          // a score is saved whole, and the cavity count follows the cavity answer
    if (code_(merged.cavity) === 'N' && str_(merged.n_cavities) === '') { merged.n_cavities = '0'; vals.n_cavities = '0'; }
    const pq = pctFromQuadrants_(merged);                        // the reader never types the percentage: it is the mean of the quadrants
    if (pq !== '') { merged.pct_lung = pq; vals.pct_lung = pq; }
    const film = readTab_(ss, defOf_('S3_CXR')).filter(function (x) { return code_(x.study_id) === code_(merged.study_id); })[0];
    if (!film) return { cid: ch.cid, status: 'rejected', errors: { study_id: 'is not on the film list (no chest radiograph recorded for it)' } };
    if (str_(merged.read_no) === '2' && code_(film.repeat_read) !== 'Y') return { cid: ch.cid, status: 'rejected', errors: { read_no: '2 (repeat read) only for films the PI has marked for a repeat read' } };
    const gaps = readerGaps_(merged, true);
    Object.keys(gaps).forEach(function (k) { errors[k] = gaps[k]; });
  }
  def.cols.forEach(function (c) {
    if (!(c.key in vals)) return;
    if (c.pi && u.role !== 'pi') { errors[c.key] = 'entered by the PI only'; return; }
    const msg = validateValue_(c, merged[c.key], merged, ctx);
    if (msg) errors[c.key] = msg;
    else if (['sidnew', 'sid', 'uniqueint'].indexOf(c.type) >= 0 && keys.indexOf(c.key) < 0 && str_(merged[c.key]) !== '') {
      const dup = rows.filter(function (x) { return (!row || x._row !== row._row) && code_(x[c.key]) === code_(merged[c.key]); })[0];
      if (dup) errors[c.key] = merged[c.key] + ' is already used in row ' + dup._row;
    }
    if (row && (c.key in base) && !sameValue_(row[c.key], base[c.key]) && !sameValue_(row[c.key], vals[c.key])) {
      errors[c.key] = 'changed on the server by someone else (now ' + (row[c.key] || 'blank') + '). Check and enter again.';
    }
  });
  if (Object.keys(errors).length) return { cid: ch.cid, status: Object.keys(errors).some(function (k) { return /someone else/.test(errors[k]); }) ? 'conflict' : 'rejected', errors: errors };
  const r = row ? row._row : Math.max(sh.getLastRow(), 1) + 1;
  sizeSheet_(sh, r, colKeys.length);
  const label = (def === READER ? file.getName() + '/' : '') + def.tab, sid = code_(merged.study_id);
  let changed = 0;
  def.cols.forEach(function (c, i) {
    if (!(c.key in vals)) return;
    const old = row ? row[c.key] : '', nv = isCode_(c) ? code_(merged[c.key]) : merged[c.key];
    if (str_(old) === str_(nv) || (str_(old) !== '' && str_(nv) !== '' && sameValue_(old, nv))) return;
    const cell = sh.getRange(r, i + 1);
    if (nv === '') cell.clearContent();
    else cell.setValue(['num', 'int', 'uniqueint', 'unitnum'].indexOf(c.type) >= 0 ? num_(nv) : nv);
    logAudit_(label, cell.getA1Notation(), sid, old, nv, c.key + ' (phone app, initials ' + str_(ch.by).slice(0, 10) + ')', u.email);
    changed++;
  });
  if (sid && def !== READER) touched[sid] = true;
  const key = {};
  keys.forEach(function (k) { key[k] = merged[k]; });
  if (!serial && !row && ch.create) keysSheet.appendRow([str_(ch.cid), tab, keys.map(function (k) { return code_(merged[k]); }).join(' '), u.email]);   // remember this save, so a resend is not a duplicate
  return { cid: ch.cid, status: 'ok', changed: changed, key: key, row: r };
}

// ---------------------------------------------------------------- PI: invitations and revocation
function menuAppInvite() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_();
  let appUrl = P.getProperty('APP_URL') || '';
  const svc = ScriptApp.getService(), live = svc && svc.getUrl ? svc.getUrl() : '';
  let api = P.getProperty('API_URL') || '';                    // saved once, so a code update never loses it
  if (!api) {
    const q = ui.prompt('Web app address', 'Paste the web app URL from Deploy > Manage deployments (it ends with /exec). It is saved, so you are asked only once.' + (live ? '\n\nThe project reports: ' + live : ''), ui.ButtonSet.OK_CANCEL);
    if (q.getSelectedButton() !== ui.Button.OK) return;
    api = q.getResponseText().trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(api)) { ui.alert('Not saved', 'That is not a web app address ending in /exec.', ui.ButtonSet.OK); return; }
    P.setProperty('API_URL', api);
  }
  if (!api) { ui.alert('Deploy first', 'Deploy this project as a web app (Deploy > New deployment > Web app; Execute as: Me; Who has access: Anyone), then try again.', ui.ButtonSet.OK); return; }
  if (!appUrl) {
    const a = ui.prompt('Phone app address', 'Address where the TBDM Field App is published (https://...):', ui.ButtonSet.OK_CANCEL);
    if (a.getSelectedButton() !== ui.Button.OK) return;
    appUrl = a.getResponseText().trim();
    if (!/^(https:\/\/\S+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\S*)$/.test(appUrl)) { ui.alert('Not saved', 'The address must start with https://', ui.ButtonSet.OK); return; }
    P.setProperty('APP_URL', appUrl);
  }
  const b = ui.prompt('Invite a team member', 'Google account e-mail of the person (they must already be in a study user list, or in an extra role made in the phone\'s Role manager):', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const email = b.getResponseText().trim().toLowerCase(), role = roleOf_(email);
  if (!role) { ui.alert('Not invited', email + ' is not in any study user list. Add them with "PI: manage users and sharing" first.', ui.ButtonSet.OK); return; }
  const code = randomHex_(32);
  P.setProperty('APPJOIN_' + sha256_(code), JSON.stringify({ email: email, expires: Date.now() + APP_JOIN_DAYS * 864e5 }));
  const link = appUrl.replace(/#.*$/, '') + '#join=' + encodeURIComponent(api) + '~' + code;
  const rname = accessRoleName_(role, accessStored_());
  logAudit_('APP', '', '', '', email, 'phone app invitation issued (' + rname + ')', '');
  ui.alert('Invitation for ' + email + ' (' + rname + ')', 'Send this link to ' + email + ' privately. It works once, on one phone, and expires in ' + APP_JOIN_DAYS + ' days:\n\n' + link, ui.ButtonSet.OK);
}
// ---------------------------------------------------------------- in-place upgrade (keeps phones, invitations and the web app address)
// A new script version can add, remove or reorder columns. This moves every existing row into the new
// layout by column name, after saving a CSV backup of every tab. Phones keep their tokens, because those
// live in the script properties of THIS project, and the web app address stays the same as long as the
// new code is deployed as a new version of the existing deployment.
function upgradePlan_(ss, defs, label) {
  const plan = [];
  (defs || SCHEMA).forEach(function (t) {
    const sh = ss.getSheetByName(t.tab);
    if (!sh || sh.getLastColumn() === 0) return;
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(function (x) { return String(x).trim(); }).filter(function (x) { return x !== ''; });
    const want = t.cols.map(function (c) { return c.key; });
    if (!head.length || head.join('|') === want.join('|')) return;
    const shared = want.filter(function (k) { return head.indexOf(k) >= 0; }).length;
    if (shared < Math.ceil(want.length / 2)) throw new Error('Tab ' + t.tab + ' does not look like the study tab (only ' + shared + ' of ' + want.length + ' columns match). Nothing was changed.');
    plan.push({ ss: ss, label: (label || '') + t.tab, t: t, head: head, want: want, added: want.filter(function (k) { return head.indexOf(k) < 0; }), dropped: head.filter(function (k) { return want.indexOf(k) < 0; }) });
  });
  return plan;
}
function migrateTab_(ss, p) {
  const sh = ss.getSheetByName(p.t.tab), n = p.head.length, lastRow = Math.max(sh.getLastRow(), 1);
  const all = sh.getRange(1, 1, lastRow, n).getValues();
  const out = all.slice(1).map(function (r) { return p.want.map(function (k) { const i = p.head.indexOf(k); return i < 0 ? '' : r[i]; }); });
  const lost = p.dropped.map(function (k) {
    const i = p.head.indexOf(k);
    return { key: k, filled: all.slice(1).filter(function (r) { return String(r[i] === undefined || r[i] === null ? '' : r[i]).trim() !== ''; }).length };
  });
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  buildTab_(ss, p.t);                                           // header, notes, formats, rules: formats first, so text such as 00123 stays text
  if (out.length) sh.getRange(2, 1, out.length, p.want.length).setValues(out);
  return lost;
}
function backupBeforeUpgrade_(ss, why, readers) {                // every data tab (and the readers' score tabs) as CSV, at the width it has NOW (not the new width)
  const P = props_(), base = DriveApp.getFolderById(P.getProperty('FOLDER_ID'));
  const it = base.getFoldersByName(CFG.EXPORTS), exp = it.hasNext() ? it.next() : base.createFolder(CFG.EXPORTS);
  const f = exp.createFolder(Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd_HHmm') + '_' + why);
  SCHEMA.forEach(function (t) {
    const sh = ss.getSheetByName(t.tab);
    if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 1) return;
    const matrix = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
    f.createFile(t.tab + '.csv', matrix.map(function (r) { return r.map(csvField_).join(','); }).join('\r\n') + '\r\n', MimeType.CSV);
  });
  (readers || []).forEach(function (x) {
    const sh = x.ss.getSheetByName(READER.tab);
    if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 1) return;
    const matrix = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
    f.createFile('CXR_Reader' + x.r + '_' + READER.tab + '.csv', matrix.map(function (r) { return r.map(csvField_).join(','); }).join('\r\n') + '\r\n', MimeType.CSV);
  });
  logAudit_('EXPORT', '', '', '', f.getName(), 'backup before upgrade (' + why + ')', me_());
  return f;
}
function menuUpgrade() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_(), ss = dataSS_();
  const readers = [1, 2].map(function (r) { const id = P.getProperty('READER' + r + '_ID'); return id ? { r: r, ss: SpreadsheetApp.openById(id) } : null; }).filter(Boolean);
  let plan = upgradePlan_(ss);
  readers.forEach(function (x) { plan = plan.concat(upgradePlan_(x.ss, [READER], 'CXR_Reader' + x.r + '/')); });      // the readers' files move with the workbook
  if (!plan.length) {
    P.setProperty('SCHEMA_VER', String(CFG.SCHEMA_VER)); P.setProperty('VERSION', CFG.VERSION);
    ui.alert('Already up to date', 'Every tab already has the columns this script expects. Nothing was changed. If a part of the workbook looks wrong, use "PI: set up or repair".', ui.ButtonSet.OK);
    return;
  }
  const list = plan.map(function (p) { return p.label + ':' + (p.added.length ? ' new ' + p.added.join(', ') + ';' : '') + (p.dropped.length ? ' removed ' + p.dropped.join(', ') + ';' : '') + (!p.added.length && !p.dropped.length ? ' column order;' : ''); }).join('\n');
  const yes = ui.alert('Upgrade the workbook in place', 'These tabs will change:\n\n' + list + '\n\nA backup of every tab is saved first (CSV files in the exports folder). All rows are kept. ' +
    'Phones, their invitations and the web app address are not touched. Entries made on phones meanwhile wait on the phone and are sent afterwards.\n\nContinue?', ui.ButtonSet.YES_NO);
  if (yes !== ui.Button.YES) return;
  const backup = backupBeforeUpgrade_(ss, 'before_upgrade_to_schema_' + CFG.SCHEMA_VER, readers);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);                                         // phones cannot write while the rows are moved
  const report = [];
  try {
    plan.forEach(function (p) {
      const lost = migrateTab_(p.ss, p);
      SpreadsheetApp.flush();
      logAudit_('SCHEMA_UPGRADE', '', '', 'removed: ' + (p.dropped.join(', ') || 'none'), 'added: ' + (p.added.join(', ') || 'none'), p.label + ' moved to schema ' + CFG.SCHEMA_VER, me_());
      report.push(p.label + ': ' + lost.filter(function (l) { return l.filled > 0; }).map(function (l) { return l.key + ' held ' + l.filled + ' value(s), kept only in the backup'; }).join('; '));
    });
    P.setProperty('SCHEMA_VER', String(CFG.SCHEMA_VER));        // the rows now match this script
  } finally { lock.releaseLock(); }
  buildAll_(ss);
  readers.forEach(function (x) { buildTab_(x.ss, READER); protectReader_(x.ss); });
  applyAccess_(null);
  installTriggers_();
  refreshAll();
  integrityCheck_(ss);
  P.setProperty('VERSION', CFG.VERSION); P.setProperty('SCHEMA_VER', String(CFG.SCHEMA_VER));
  const kept = report.filter(function (r) { return /held/.test(r); });
  ui.alert('Upgrade complete', plan.length + ' tab(s) moved to the new layout. All rows were kept.\n\nBackup: ' + CFG.EXPORTS + '/' + backup.getName() +
    (kept.length ? '\n\nValues in removed columns (only in the backup now):\n' + kept.join('\n') : '\n\nNo values were in the removed columns.') +
    '\n\nPhones do not need new invitations.', ui.ButtonSet.OK);
}
function menuUpdateHelp() {
  SpreadsheetApp.getUi().alert('Update the system without re-inviting anyone',
    '1. In THIS workbook: Extensions > Apps Script. Select all the code, paste the new version over it, Save.\n\n' +
    '2. Deploy > Manage deployments > the pencil (Edit) > Version: "New version" > Deploy. Do NOT choose "New deployment": that makes a new web app address and every phone would need an invitation.\n\n' +
    '3. Reload this workbook. If the update says tabs changed, run "PI: upgrade the workbook in place".\n\n' +
    '4. The phone app updates itself the next time a phone is online. Entries made before the update wait on the phone and are sent afterwards.\n\n' +
    'Or, once the one-time setup is done: use "PI: update the script from GitHub", which does steps 1 and 2 for you after you type the update code given in the chat.\n\n'+
    'Phones stay signed in because their access is stored inside this project, not in the code.', SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---------------------------------------------------------------- update this script from GitHub (PI only, every update confirmed by the PI)
// The new script is published as a plain file in the public tbdm-field repository. Nothing is installed without the PI typing the 8-character code that the
// person who prepared the update gives out in the chat (the first 8 characters of the SHA-256 of the file). A changed or tampered file therefore cannot be installed,
// even by someone who controls the GitHub account. Before anything changes a restore point is saved (Deploy > Manage deployments > Version), and the web app
// address stays the same because the existing deployment is moved to the new version, not replaced.
const UPDATE_SRC = 'https://raw.githubusercontent.com/IR1S-VIR1S/tbdm-field/main/script/TBDM_DataSystem.gs';
function hex_(bytes) { return bytes.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join(''); }
function sha256hex_(text) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)); }
function scriptApi_(method, path, body) {
  const r = UrlFetchApp.fetch('https://script.googleapis.com/v1/' + path, { method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: body ? JSON.stringify(body) : undefined });
  const code = r.getResponseCode(), text = r.getContentText();
  if (code >= 300) throw new Error(scriptApiHelp_(code, text));
  return text ? JSON.parse(text) : {};
}
function scriptApiHelp_(code, text) {
  const raw = '\n\nGoogle said: ' + String(text).replace(/\s+/g, ' ').slice(0, 300);
  if (code === 403 && /User has not enabled the Apps Script API/i.test(text))
    return 'The Google Apps Script API is switched off for your account. Open https://script.google.com/home/usersettings , turn "Google Apps Script API" on, wait a few minutes, then run this again.' + raw;
  if (code === 403 && /SERVICE_DISABLED|has not been used in project|accessNotConfigured/i.test(text)) {
    const m = /project[ =](\d+)/i.exec(text);
    return 'The Apps Script API is not turned on inside the Google Cloud project behind this script' + (m ? ' (project ' + m[1] + ')' : '') + '. This is separate from your account setting. Send this message to Claude for the next step.' + raw;
  }
  if (code === 401 || code === 403) return 'Google refused permission to edit this script (' + code + '). Check the "oauthScopes" line in appsscript.json, then run this again and allow the permissions.' + raw;
  return 'Google answered with error ' + code + '.' + raw;
}
function menuUpdateScript() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), id = ScriptApp.getScriptId();
  const stop = function (title, msg) { ui.alert(title, msg + '\n\nNothing was changed.', ui.ButtonSet.OK); };
  let res;
  try { res = UrlFetchApp.fetch(UPDATE_SRC + '?t=' + new Date().getTime(), { muteHttpExceptions: true }); } catch (e) { stop('Could not reach GitHub', String(e.message || e)); return; }
  if (res.getResponseCode() !== 200) { stop('Could not read the new script', 'GitHub answered ' + res.getResponseCode() + '.'); return; }
  const code = res.getContentText(), hash = sha256hex_(code);
  const must = ['onOpen', 'doPost', 'requirePI_', 'menuUpdateScript', 'setup'];          // the pieces any working version has, including this updater itself
  const missing = must.filter(function (m) { return code.indexOf('function ' + m) < 0; });
  if (missing.length) { stop('The new script looks incomplete', 'It lacks: ' + missing.join(', ') + '.'); return; }
  try { new Function(code); } catch (e) { stop('The new script has a syntax error', String(e.message || e)); return; }
  let cur, mine, changed = false;
  try {
    cur = scriptApi_('GET', 'projects/' + id + '/content');
    mine = (cur.files || []).filter(function (f) { return f.type === 'SERVER_JS' && /function onOpen\b/.test(f.source || ''); });
    if (mine.length !== 1) { stop('Cannot tell which file is the study script', 'Found ' + mine.length + ' candidates. Update by pasting instead.'); return; }
    const curHash = sha256hex_(mine[0].source), ver = function (t) { const m = /VERSION: '([^']*)'/.exec(t); return m ? m[1] : '?'; };
    if (curHash === hash) { ui.alert('Already up to date', 'This script is already identical to the one on GitHub (code ' + hash.slice(0, 8) + ').', ui.ButtonSet.OK); return; }
    const ask = ui.prompt('Update the study script',
      'Installed now: version ' + ver(mine[0].source) + ', code ' + curHash.slice(0, 8) + '.\nOn GitHub: version ' + ver(code) + '.\n\n' +
      'Type the 8-character update code that Claude gave you in the chat for this update. If you were not given one, press Cancel.', ui.ButtonSet.OK_CANCEL);
    if (ask.getSelectedButton() !== ui.Button.OK) return;
    if (ask.getResponseText().trim().toLowerCase() !== hash.slice(0, 8)) { stop('The code does not match', 'The file on GitHub is not the one you were given the code for, or the code was mistyped.'); return; }
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyy-MM-dd HH:mm');
    const before = scriptApi_('POST', 'projects/' + id + '/versions', { description: 'before update ' + stamp + ' (' + curHash.slice(0, 8) + ')' });
    mine[0].source = code;
    scriptApi_('PUT', 'projects/' + id + '/content', { files: cur.files.map(function (f) { return { name: f.name, type: f.type, source: f.source }; }) });
    changed = true;
    const after = scriptApi_('POST', 'projects/' + id + '/versions', { description: 'update ' + stamp + ' (' + hash.slice(0, 8) + ')' });
    const deps = (scriptApi_('GET', 'projects/' + id + '/deployments').deployments || []).filter(function (d) {
      return d.deploymentConfig && d.deploymentConfig.versionNumber && (d.entryPoints || []).some(function (e) { return e.entryPointType === 'WEB_APP'; });
    });
    let where;
    if (deps.length === 1) {
      scriptApi_('PUT', 'projects/' + id + '/deployments/' + deps[0].deploymentId, { deploymentConfig: { scriptId: id, versionNumber: after.versionNumber, manifestFileName: 'appsscript', description: 'update ' + stamp + ' (' + hash.slice(0, 8) + ')' } });
      where = 'The web app was moved to version ' + after.versionNumber + ' at the same address, so every phone keeps working.';
    } else where = 'The web app was NOT moved (found ' + deps.length + ' web app deployments). Do it by hand: Deploy > Manage deployments > pencil > Version: New version > Deploy.';
    logAudit_('SCRIPT_UPDATE', '', '', curHash.slice(0, 8), hash.slice(0, 8), 'versions ' + before.versionNumber + ' to ' + after.versionNumber);
    ui.alert('Script updated', 'Installed version ' + ver(code) + ' (code ' + hash.slice(0, 8) + ').\n\n' + where + '\n\nReload this workbook so the menu refreshes. If anything looks wrong, go back with Deploy > Manage deployments > pencil > choose version ' + before.versionNumber + ' ("before update").', ui.ButtonSet.OK);
  } catch (e) {
    if (changed) ui.alert('The update stopped part way', 'The new code is installed but the web app was not moved to it. ' + String(e.message || e) + '\n\nFinish by hand: Deploy > Manage deployments > pencil > Version: New version > Deploy. To undo, choose the version called "before update".', ui.ButtonSet.OK);
    else stop('The update did not finish', String(e.message || e));
  }
}

function menuAppRevoke() {
  requirePI_();
  const ui = SpreadsheetApp.getUi(), P = props_();
  const b = ui.prompt('Revoke phone app access', 'Google account e-mail whose phones should lose access:', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const email = b.getResponseText().trim().toLowerCase(), all = P.getProperties();
  let n = 0;
  Object.keys(all).forEach(function (k) {
    if (!/^APP(JOIN)?_/.test(k)) return;
    try { if (JSON.parse(all[k]).email === email) { P.deleteProperty(k); n++; } } catch (e) { /* not an app entry */ }
  });
  logAudit_('APP', '', '', '', email, 'phone app access revoked (' + n + ')', '');
  ui.alert('Revoked', n + ' phone(s) or unused invitation(s) of ' + email + ' can no longer reach the study data. Data still waiting on those phones will not be accepted.', ui.ButtonSet.OK);
}
