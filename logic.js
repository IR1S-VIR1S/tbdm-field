// GENERATED from TBDM_DataSystem.gs by build.js. Do not edit by hand.
'use strict';
const CFG = {
  VERSION: '1.1',
  ID_PREFIX: 'TBDM-',
  ID_MAX: 300,
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
  return [col('temp_f', 'Temperature, deg F, axillary' + sfx, 'num', { min: 93, max: 108 }),
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
    col('optout_questionnaires', 'Declined the questionnaires on the consent form (Study 4)', 'list', { codes: YN }),
    col('optout_spirometry', 'Declined spirometry on the consent form (Study 5)', 'list', { codes: YN }),
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
    col('time_drawn', 'Time drawn, hh:mm', 'time'),
    col('time_analysed', 'Time analysed, hh:mm', 'time'),
    col('fasting', 'Fasting at the time of the sample (Visit 1)', 'list', { codes: YN }),
    col('symptomatic', 'Hepatotoxicity symptoms when this test was taken (U visits only)', 'list', { codes: YN }),
    col('lab_status', 'Status of this laboratory visit', 'list', { codes: [['1', 'done'], ['2', 'not done'], ['3', 'declined'], ['4', 'sample rejected']] }),
    col('source_report_no', 'Laboratory report number (source document)', 'text', { max: 30 }),
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
    col('smear_date', 'Sputum smear date (V3, V5)', 'date'),
    col('smear_result', 'Sputum smear result (V3, V5)', 'list', { codes: SMEAR.concat([['X', 'not done']]) }),
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
    col('e2_rucam_a1', 'E2: RUCAM score, assessor 1', 'int', { min: -10, max: 14 }),
    col('e2_rucam_a2', 'E2: RUCAM score, assessor 2', 'int', { min: -10, max: 14 }),
    col('e2_rucam_final', 'E2: RUCAM score, agreed', 'int', { min: -10, max: 14 }),
    col('e2_ctcae', 'E2: CTCAE version 5.0 grade', 'list', { codes: [['1', 'grade 1'], ['2', 'grade 2'], ['3', 'grade 3'], ['4', 'grade 4'], ['5', 'grade 5']] }),
    col('e2_hys_law', 'E2: meets Hy\'s law', 'list', { codes: YN }),
    col('e3_procedure', 'E3: procedure', 'list', { codes: [['SP', 'spirometry'], ['QU', 'questionnaire'], ['AN', 'anthropometry']] }),
    col('e4_choice', 'E4: participant\'s choice about data', 'list', { codes: [['R', 'keep data collected so far'], ['D', 'destroy all data']] }),
    col('outcome', 'Event outcome', 'list', { codes: [['R', 'resolved'], ['O', 'ongoing'], ['S', 'resolved with sequelae'], ['D', 'died']] }),
    col('irb_reported_date', 'Date reported to the IRB (serious events, within 7 days)', 'date'),
    col('entered_by', 'Entered by (initials)', 'text', { max: 10 })] },

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
  col('pct_lung', 'Percentage of the total lung field affected, 0 to 100', 'num', { min: 0, max: 100 }),
  col('cavity', 'Any cavity', 'list', { codes: YN }),
  col('n_cavities', 'Number of cavities', 'int', { min: 0, max: 20 }),
  col('reader_initials', 'Your initials', 'text', { max: 10 })] };

// Calculated tabs: [variable, description, type d date / n number / t text]
const DERIVED = {
  DERIVED_PARTICIPANT: [
    ['study_id', 'Study number', 't'], ['att_start_date', 'Date ATT started (day 0)', 'd'],
    ['dm_status', 'Diabetes at enrolment: K known, N new, 0 not diabetic', 't'],
    ['bmi_v1', 'Body mass index at Visit 1, kg/m2, from weight and height', 'n'],
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
    ['visit', 'Visit', 't'], ['check', 'What needs checking', 't'], ['detail', 'Detail', 't']],
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
  '4. Laboratory values: choose the unit first, then type the value, the laboratory upper limit of normal and the report number.',
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
  'percentage of the total lung field affected (0 to 100); any cavity (Y or N); number of cavities; your initials.',
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
function bmi_(w, h) { const kg = num_(w), cm = num_(h); if (kg === null || cm === null || cm <= 0) return ''; return round_(kg / Math.pow(cm / 100, 2), 1); }
function ratio_(a, b) { const x = num_(a), y = num_(b); return x === null || y === null || y <= 0 ? '' : round_(x / y, 2); }
function timika_(pct, cavity) { const p = num_(pct), c = code_(cavity); if (p === null || (c !== 'Y' && c !== 'N')) return ''; return p + (c === 'Y' ? 40 : 0); }

function tbscore_(r, bmi, pulseLimit) {                     // Bandim TBscore, 0 to 13; blank if any item missing
  const need = TB_SYMPTOMS.concat(['pallor', 'auscultation', 'temp_f', 'pulse_min', 'muac_mm']);
  for (let i = 0; i < need.length; i++) if (str_(r[need[i]]) === '') return '';
  if (bmi === '' || bmi === null) return '';
  let s = 0;
  TB_SYMPTOMS.forEach(function (k) { if (code_(r[k]) === 'Y') s++; });
  if (code_(r.pallor) === 'P') s++;
  if (code_(r.auscultation) === 'P') s++;
  if (num_(r.temp_f) > 98.6) s++;   // 37 C
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

// data: { TAB: [row objects with string values and _row] }; today: 'yyyy-mm-dd'
function computeDerived_(data, today) {
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
    out.participant.push([sid, e.att_start_date || '', e.dm_status || '', bmi1,
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
    if (r.study_id && !enrol[r.study_id]) Q(r.study_id, 'S0_SCREEN', r._row, '', 'Study number not yet in S1_ENROL', '');
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
      if (!phq[sid + '|V1'] && e.optout_questionnaires !== 'Y') Q(sid, 'PHQ_GAD', '', 'V1', 'Baseline questionnaires missing', '');
    }
  });
  const used = ids.filter(idOk_).concat(Object.keys(destroyed).filter(idOk_)).map(function (s) { return +s.slice(CFG.ID_PREFIX.length); });
  if (used.length) {
    const top = Math.max.apply(null, used);
    for (let k = 1; k < top; k++) {
      const sid = idOf_(k);
      if (!enrol[sid] && !destroyed[sid]) Q(sid, 'S1_ENROL', '', '', 'Study number skipped', 'explain the gap in the paper linking log');
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
    if (num_(r.tbili) !== null && num_(r.bili_uln) === null) tag('Bilirubin upper limit of normal missing', 'needed for the liver injury definition');
    const a = minutes_(r.time_drawn), b = minutes_(r.time_analysed);
    if (a !== null && b !== null) {
      if (b < a) tag('Time analysed is before time drawn', '');
      else if (b - a > 360) tag('Analysed more than 6 hours after drawing', (b - a) + ' minutes');
    }
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
    if (filled > 0 && (enrol[r.study_id] || {}).optout_questionnaires === 'Y') tag('Questionnaire entered but the participant opted out on the consent form', '');
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
    if ((enrol[r.study_id] || {}).optout_spirometry === 'Y') tag('Spirometry done but the participant opted out on the consent form', '');
  });
  T('S3_CXR').forEach(function (r) {
    if (!r.study_id) return;
    const both = timika_(r.r1_pct, r.r1_cavity) !== '' && timika_(r.r2_pct, r.r2_cavity) !== '';
    if (both && !r.resolution) Q(r.study_id, 'S3_CXR', r._row, '', 'Reader scores need resolution (PI)', '');
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
    if (r.event_type === 'E2' && (num_(r.e2_rucam_a1) === null || num_(r.e2_rucam_a2) === null)) tag('RUCAM scores from both assessors needed', '');
    if (r.event_type === 'E4' && !r.e4_choice) tag('Withdrawal data choice missing', '');
  });
  T('END_STUDY').forEach(function (r) {
    if (r.study_id && r.status === 'W' && !r.retention) Q(r.study_id, 'END_STUDY', r._row, '', 'Withdrawal data choice missing', '');
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

const APP_KEYS = {                     // how a row is identified for each tab
  S0_SCREEN: ['screen_no'], S1_ENROL: ['study_id'], S2_BASELINE: ['study_id'], S3_CXR: ['study_id'],
  LABS: ['study_id', 'visit'], VISITS: ['study_id', 'visit'], SPIRO: ['study_id'], PHQ_GAD: ['study_id', 'visit'],
  EVENTS: ['event_no'], END_STUDY: ['study_id'], QC_LOG: ['qc_no'], R_SCORES: ['study_id', 'read_no']
};
const APP_SERIAL = { S0_SCREEN: 'screen_no', EVENTS: 'event_no', QC_LOG: 'qc_no' };   // numbered by the server
