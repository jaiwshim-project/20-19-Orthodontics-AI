// =============================================================
// 20-19 Orthodontics AI — Neo4j 지식그래프 스키마
// 버전: 0.1.0
// 목적: 환자/진단/치아/치료/문헌의 관계를 그래프로 표현해
//       유사 환자 검색·치료계획 추천·재발 위험 클러스터링을 지원.
// =============================================================

// -------- Constraints --------
CREATE CONSTRAINT patient_id IF NOT EXISTS
FOR (p:Patient) REQUIRE p.id IS UNIQUE;

CREATE CONSTRAINT diagnosis_id IF NOT EXISTS
FOR (d:Diagnosis) REQUIRE d.id IS UNIQUE;

CREATE CONSTRAINT tooth_fdi IF NOT EXISTS
FOR (t:Tooth) REQUIRE t.fdi IS UNIQUE;

CREATE CONSTRAINT treatment_id IF NOT EXISTS
FOR (tp:TreatmentPlan) REQUIRE tp.id IS UNIQUE;

CREATE CONSTRAINT lit_pmid IF NOT EXISTS
FOR (l:LiteratureRef) REQUIRE l.pmid IS UNIQUE;

// -------- Indexes --------
CREATE INDEX patient_age IF NOT EXISTS FOR (p:Patient) ON (p.age);
CREATE INDEX patient_age_group IF NOT EXISTS FOR (p:Patient) ON (p.ageGroup);
CREATE INDEX diagnosis_type IF NOT EXISTS FOR (d:Diagnosis) ON (d.type);
CREATE INDEX symptom_name IF NOT EXISTS FOR (s:Symptom) ON (s.name);
CREATE INDEX outcome_success IF NOT EXISTS FOR (o:Outcome) ON (o.success);

// -------- Node Labels --------
// (:Patient {id, age, gender, ageGroup, createdAt})
// (:Diagnosis {id, type, date, score, recommendation})
// (:Tooth {fdi, status, position})  status: present|missing|extracted|impacted
// (:Symptom {name, severity})        e.g. crowding, openbite, deep bite
// (:TreatmentPlan {id, phase, durationMonths})
// (:Appliance {type, brand})         e.g. Damon, Invisalign, Hawley
// (:Outcome {success, timeToRelapseMonths, satisfaction})
// (:LiteratureRef {pmid, title, year, doi})

// -------- Relationships --------
// (:Patient)-[:HAS_DIAGNOSIS {date}]->(:Diagnosis)
// (:Diagnosis)-[:INVOLVES {role}]->(:Tooth)
// (:Diagnosis)-[:SHOWS {severity}]->(:Symptom)
// (:Diagnosis)-[:RECOMMENDS]->(:TreatmentPlan)
// (:TreatmentPlan)-[:USES {periodMonths}]->(:Appliance)
// (:TreatmentPlan)-[:RESULTS_IN]->(:Outcome)
// (:Diagnosis)-[:CITES {relevance}]->(:LiteratureRef)
// (:Patient)-[:SIMILAR_TO {score, computedAt}]->(:Patient)

// =============================================================
// 샘플 데이터 (시드)
// =============================================================
MERGE (p1:Patient {id: 'P1001'}) SET p1.age = 28, p1.gender = 'female', p1.ageGroup = 'adult';
MERGE (p2:Patient {id: 'P1002'}) SET p2.age = 13, p2.gender = 'male',   p2.ageGroup = 'child';

MERGE (s1:Symptom {name: 'Crowding'})  SET s1.severity = 'moderate';
MERGE (s2:Symptom {name: 'Class II'})  SET s2.severity = 'mild';
MERGE (s3:Symptom {name: 'Deep Bite'}) SET s3.severity = 'severe';

MERGE (t14:Tooth {fdi: 14}) SET t14.status = 'present';
MERGE (t24:Tooth {fdi: 24}) SET t24.status = 'present';
MERGE (t34:Tooth {fdi: 34}) SET t34.status = 'present';
MERGE (t44:Tooth {fdi: 44}) SET t44.status = 'present';

MERGE (d1:Diagnosis {id: 'D2001'}) SET d1.type = 'extraction', d1.date = date('2026-04-15'), d1.score = 78, d1.recommendation = 'extract';
MERGE (d2:Diagnosis {id: 'D2002'}) SET d2.type = 'growth',     d2.date = date('2026-04-18'), d2.score = 62, d2.recommendation = 'two_phase';

MERGE (tp1:TreatmentPlan {id: 'TP3001'}) SET tp1.phase = 'phase1', tp1.durationMonths = 22;
MERGE (a1:Appliance {type: 'fixed_brackets', brand: 'Damon Q2'});
MERGE (a2:Appliance {type: 'twin_block', brand: 'Custom'});

MERGE (o1:Outcome {success: true, timeToRelapseMonths: 36, satisfaction: 4.6});

MERGE (l1:LiteratureRef {pmid: '12345678'}) SET l1.title = 'Long-term stability of orthodontic treatment', l1.year = 2024;

// 관계 생성
MERGE (p1)-[:HAS_DIAGNOSIS {date: date('2026-04-15')}]->(d1);
MERGE (d1)-[:SHOWS {severity: 'moderate'}]->(s1);
MERGE (d1)-[:SHOWS {severity: 'mild'}]->(s2);
MERGE (d1)-[:INVOLVES {role: 'extract'}]->(t14);
MERGE (d1)-[:INVOLVES {role: 'extract'}]->(t24);
MERGE (d1)-[:INVOLVES {role: 'extract'}]->(t34);
MERGE (d1)-[:INVOLVES {role: 'extract'}]->(t44);
MERGE (d1)-[:RECOMMENDS]->(tp1);
MERGE (tp1)-[:USES {periodMonths: 22}]->(a1);
MERGE (tp1)-[:RESULTS_IN]->(o1);
MERGE (d1)-[:CITES {relevance: 0.92}]->(l1);

MERGE (p2)-[:HAS_DIAGNOSIS {date: date('2026-04-18')}]->(d2);
MERGE (d2)-[:SHOWS {severity: 'mild'}]->(s2);
MERGE (d2)-[:SHOWS {severity: 'severe'}]->(s3);
MERGE (d2)-[:RECOMMENDS]->(:TreatmentPlan {id: 'TP3002', phase: 'phase1_growth', durationMonths: 18});
MATCH (tp2:TreatmentPlan {id: 'TP3002'})
MERGE (tp2)-[:USES {periodMonths: 12}]->(a2);

// =============================================================
// 샘플 쿼리 10선
// =============================================================

// 1. 특정 환자의 전체 진단·치료·결과 그래프
MATCH (p:Patient {id: 'P1001'})-[:HAS_DIAGNOSIS]->(d)-[:RECOMMENDS]->(tp)-[:RESULTS_IN]->(o)
RETURN p, d, tp, o;

// 2. 유사 환자 검색 (같은 증상 + 비슷한 연령)
MATCH (target:Patient {id: 'P1001'})-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:SHOWS]->(s:Symptom)
MATCH (other:Patient)-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:SHOWS]->(s)
WHERE other.id <> target.id
  AND abs(other.age - target.age) <= 5
  AND other.ageGroup = target.ageGroup
RETURN other, count(DISTINCT s) AS sharedSymptoms
ORDER BY sharedSymptoms DESC LIMIT 10;

// 3. 발치 케이스 중 5년 이상 안정적인 환자
MATCH (p:Patient)-[:HAS_DIAGNOSIS]->(d:Diagnosis {type: 'extraction'})-[:RECOMMENDS]->(:TreatmentPlan)-[:RESULTS_IN]->(o:Outcome)
WHERE o.success = true AND o.timeToRelapseMonths >= 60
RETURN p.id, p.age, p.gender, o.timeToRelapseMonths
ORDER BY o.timeToRelapseMonths DESC;

// 4. 가장 자주 함께 발치되는 치아 조합
MATCH (d:Diagnosis)-[:INVOLVES {role: 'extract'}]->(t1:Tooth)
MATCH (d)-[:INVOLVES {role: 'extract'}]->(t2:Tooth)
WHERE id(t1) < id(t2)
RETURN t1.fdi AS tooth1, t2.fdi AS tooth2, count(*) AS frequency
ORDER BY frequency DESC LIMIT 10;

// 5. 어린이 환자의 가장 효과적인 치료 (성공률 + 만족도)
MATCH (p:Patient {ageGroup: 'child'})-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:RECOMMENDS]->(tp:TreatmentPlan)-[:USES]->(a:Appliance)
MATCH (tp)-[:RESULTS_IN]->(o:Outcome)
RETURN a.type, a.brand,
       count(*) AS cases,
       avg(toFloat(o.satisfaction)) AS avgSatisfaction,
       sum(CASE WHEN o.success THEN 1 ELSE 0 END) * 1.0 / count(*) AS successRate
ORDER BY successRate DESC;

// 6. 재발 위험 클러스터 (24개월 이내 재발)
MATCH (p:Patient)-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:RECOMMENDS]->(:TreatmentPlan)-[:RESULTS_IN]->(o:Outcome)
WHERE o.timeToRelapseMonths < 24 AND o.success = false
WITH p
MATCH (p)-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:SHOWS]->(s:Symptom)
RETURN s.name AS commonSymptom, count(*) AS occurrences
ORDER BY occurrences DESC LIMIT 5;

// 7. 진단 근거 문헌 인용 카운트
MATCH (l:LiteratureRef)<-[:CITES]-(:Diagnosis)
RETURN l.pmid, l.title, l.year, count(*) AS citationCount
ORDER BY citationCount DESC LIMIT 20;

// 8. 환자 간 SIMILAR_TO 관계 갱신 (배치)
MATCH (p1:Patient), (p2:Patient)
WHERE p1.id < p2.id
WITH p1, p2,
  size([(p1)-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:SHOWS]->(s)<-[:SHOWS]-(:Diagnosis)<-[:HAS_DIAGNOSIS]-(p2) | s]) AS shared
WHERE shared > 0
MERGE (p1)-[r:SIMILAR_TO]->(p2)
SET r.score = shared, r.computedAt = datetime();

// 9. 특정 증상에 대한 추천 치료계획 (협업 필터링)
MATCH (target:Patient)-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:SHOWS]->(s:Symptom)
WHERE target.id = 'P1001'
WITH target, collect(s.name) AS targetSymptoms
MATCH (other:Patient)-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:SHOWS]->(s2:Symptom)
WHERE s2.name IN targetSymptoms AND other.id <> target.id
MATCH (other)-[:HAS_DIAGNOSIS]->(:Diagnosis)-[:RECOMMENDS]->(tp:TreatmentPlan)-[:RESULTS_IN]->(o:Outcome)
WHERE o.success = true
RETURN tp.phase, tp.durationMonths, count(*) AS supporters
ORDER BY supporters DESC LIMIT 5;

// 10. 감사 로그용 — 최근 30일 진단 추이
MATCH (d:Diagnosis)
WHERE d.date >= date() - duration({days: 30})
RETURN d.type, count(*) AS diagnoses, avg(d.score) AS avgScore
ORDER BY diagnoses DESC;
