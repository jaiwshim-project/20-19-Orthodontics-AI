import { getAdmin } from '../lib/supabase.js';

export const config = {
  api: { bodyParser: { sizeLimit: '25mb' } }
};

function normalizePatient(patient = {}) {
  return {
    name: patient.name || patient.patientCode || 'Unnamed case',
    age_group: patient.stage === 'mixed_dentition' ? 'child' : patient.stage === 'adult' ? 'adult' : null,
    metadata: {
      stage: patient.stage || null,
      source: 'equilibrium-analysis'
    }
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const body = req.body || {};
    const { patient = {}, analysis = {}, notes = '' } = body;

    if (!analysis || typeof analysis !== 'object') {
      return res.status(400).json({ error: 'analysis payload is required' });
    }

    try {
      const sb = getAdmin();
      let patientRow = null;
      const patientName = patient.name || patient.patientCode || 'Unnamed case';

      const { data: existing } = await sb
        .from('patients')
        .select('*')
        .eq('name', patientName)
        .limit(1);

      if (existing?.[0]) {
        patientRow = existing[0];
      } else {
        const { data, error } = await sb
          .from('patients')
          .insert(normalizePatient(patient))
          .select()
          .single();
        if (error) throw error;
        patientRow = data;
      }

      const payload = {
        patient_id: patientRow.id,
        scale: analysis.scale || {},
        upper_curves: analysis.curves?.upper || analysis.upper || {},
        lower_curves: analysis.curves?.lower || analysis.lower || {},
        ceph_analysis: analysis.cephAnalysis || { modifiers: analysis.modifiers || {} },
        plastic_model: analysis.plasticModel || {},
        discrepancy: {
          upper: analysis.upper?.discrepancyMm ?? null,
          lower: analysis.lower?.discrepancyMm ?? null,
          total: analysis.totalDiscrepancyMm ?? null
        },
        decision: analysis.decision || {},
        expert_label: analysis.expertLabel || {},
        notes,
        assets_meta: analysis.files || {}
      };

      const { data: record, error } = await sb
        .from('equilibrium_analyses')
        .insert(payload)
        .select()
        .single();
      if (error) throw error;

      return res.status(200).json({
        success: true,
        source: 'supabase',
        patient: patientRow,
        record
      });
    } catch (e) {
      console.warn('[save-equilibrium-analysis] Supabase fallback:', e.message);
      return res.status(200).json({
        success: true,
        source: 'local',
        fallback: true,
        message: 'Supabase equilibrium_analyses 테이블이 아직 적용되지 않았습니다. Supabase SQL Editor에서 db/20260616_equilibrium_analyses.sql을 실행하세요.',
        record: {
          id: 'local_' + Date.now(),
          patient,
          analysis,
          notes,
          created_at: new Date().toISOString()
        }
      });
    }
  } catch (e) {
    console.error('[save-equilibrium-analysis] failed:', e);
    return res.status(500).json({ error: e.message });
  }
}

