import copy, datetime as dt, importlib.util, pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('evalkit',ROOT/'eval.py');e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
M=e.read_json(ROOT/'manifest.json')

def sample(repeats=2,patronus_pass=True,native_pass=True):
 rows=e.plan(M,1,repeats)
 rows=[r for r in rows if r['case_id']=='C01']
 for r in rows:
  ok=patronus_pass if r['mode'].startswith('patronus') else native_pass
  start=dt.datetime(2026,10,12+(r['repeat']%3),12,r['repeat']*2+r['planned_position'],tzinfo=dt.timezone.utc)
  r.update(observation_provenance_id='SYNTHETIC-'+r['trial_id'],reference_sha256='a'*64,failure_attribution='none' if ok else 'task_path',state='completed',task_result='pass' if ok else 'fail',first_attempt_result='pass' if ok else 'fail',failure_stage='none' if ok else 'extraction',failure_detail=None if ok else 'Synthetic test failure',reference_id='SYNTHETIC-reference',condition_key='SYNTHETIC-condition',comparability='matched',started_at_utc=start.isoformat(),ended_at_utc=(start+dt.timedelta(seconds=10)).isoformat(),latency_ms=10000,tool_calls=2,user_interventions=0,user_active_seconds=0,evidence=[{'id':'SYNTHETIC-evidence','kind':'test_fixture'}])
  r['checks']={k:'pass' if ok else 'fail' for k in r['checks']};r['availability']={k:True for k in ['connector_ok','browser_ok','control_ok']};r['availability'].update(evidence_id='SYNTHETIC-control',checked_at_utc=start.isoformat());r['scorer']['id']='synthetic-test';r['execution'].update(environment='synthetic-test',tool_version='synthetic-v1',profile_alias='eval',auth_state='logged_out',cache_state='observed',actual_rendering='browser',surface_verified=True,prerequisites_verified=True)
 return rows

class EvalTests(unittest.TestCase):
 def test_manifest_unique(self):
  self.assertEqual(len(M['cases']),len({x['id'] for x in M['cases']}))
 def test_deterministic(self):self.assertEqual(e.plan(M,7,2),e.plan(M,7,2))
 def test_counterbalance(self):
  rows=e.plan(M,1,2);first=[r for r in rows if r['case_id']=='C01' and r['planned_position']==1];self.assertNotEqual(first[0]['mode'],first[1]['mode'])
 def test_gated_excluded(self):self.assertFalse(any(r['case_id'].startswith('G') for r in e.plan(M,1,2,False)))
 def test_no_unsafe_plan_side_effects(self):self.assertTrue(all(r['state']=='not_run' for r in e.plan(M,1,2)))
 def test_valid_empty(self):self.assertEqual(e.validate(M,[]),[])
 def test_valid_plan(self):self.assertEqual(e.validate(M,e.plan(M,1,2)),[])
 def test_sample_valid(self):self.assertEqual(e.validate(M,sample()),[])
 def test_no_fake_pass(self):
  rows=sample();rows[0]['checks'][next(iter(rows[0]['checks']))]='fail';self.assertTrue(e.validate(M,rows))
 def test_transport_not_site_failure(self):
  rows=sample();rows[0]['failure_stage']='connector_transport';self.assertTrue(e.validate(M,rows))
 def test_blocked_excluded(self):
  rows=e.plan(M,1,2)
  for r in rows:r.update(state='blocked',failure_stage='connector_transport',failure_detail='Synthetic outage')
  s=e.summarize(M,rows);self.assertEqual(s['matched_pairs_included'],0);self.assertFalse(s['routing'])
 def test_no_winner_from_pilot(self):self.assertEqual(e.summarize(M,sample(2,True,False))['routing'][0]['recommendation'],'insufficient_evidence')
 def test_direction_correct(self):self.assertEqual(e.summarize(M,sample(12,True,False))['routing'][0]['recommendation'],'patronus_first')
 def test_reverse_direction(self):self.assertEqual(e.summarize(M,sample(12,False,True))['routing'][0]['recommendation'],'native_first')
 def test_no_winner_on_both_pass(self):self.assertEqual(e.summarize(M,sample(12))['routing'][0]['recommendation'],'both_complete_no_accuracy_winner')
 def test_unmatched_excluded(self):
  rows=sample();rows[0]['comparability']='unmatched';self.assertEqual(e.summarize(M,rows)['matched_pairs_included'],1)
 def test_gap_excluded(self):
  rows=sample();rows[0]['started_at_utc']='2026-10-13T11:00:00+00:00';rows[0]['ended_at_utc']='2026-10-13T11:00:10+00:00';self.assertEqual(e.summarize(M,rows)['matched_pairs_included'],1)
 def test_duplicate_rejected(self):
  rows=sample();rows.append(copy.deepcopy(rows[0]));self.assertTrue(e.validate(M,rows))
 def test_cost_unknown_not_zero(self):self.assertIsNone(e.summarize(M,sample())['routing'][0]['patronus']['cost_total'])
 def test_p95_withheld_small_n(self):self.assertIsNone(e.summarize(M,sample())['routing'][0]['native']['successful_latency_p95_ms'])
 def test_missing_scorer(self):
  rows=sample();rows[0]['scorer']['id']=None;self.assertTrue(e.validate(M,rows))
 def test_schema_hash_enforced(self):
  rows=sample();rows[0]['manifest_sha256']='wrong';self.assertTrue(e.validate(M,rows))
 def test_pair_reference_mismatch(self):
  rows=sample();rows[0]['reference_id']='different';self.assertEqual(e.summarize(M,rows)['matched_pairs_included'],1)
 def test_intervention_recorded(self):
  rows=sample();rows[0]['user_interventions']=None;self.assertTrue(e.validate(M,rows))
 def test_single_day_not_enough(self):
  rows=sample(12,True,False)
  for r in rows:
   t=dt.datetime(2026,10,13,12,r['repeat']*2+r['planned_position'],tzinfo=dt.timezone.utc);r['started_at_utc']=t.isoformat();r['ended_at_utc']=(t+dt.timedelta(seconds=10)).isoformat();r['availability']['checked_at_utc']=t.isoformat()
  self.assertEqual(e.summarize(M,rows)['routing'][0]['recommendation'],'insufficient_evidence')

 def test_copied_pairs_rejected(self):
  rows=sample(3,True,False);duplicate=copy.deepcopy(rows)
  for r in duplicate:r['trial_id']+='-copy';r['pair_id']+='-copy'
  self.assertTrue(e.validate(M,rows+duplicate))
 def test_http_in_browser_arm_rejected(self):
  rows=sample();next(r for r in rows if r['mode'].startswith('patronus'))['execution']['actual_rendering']='http';self.assertTrue(e.validate(M,rows))
 def test_nan_and_bool_rejected(self):
  rows=sample();rows[0]['latency_ms']=float('nan');rows[0]['tool_calls']=True;self.assertTrue(e.validate(M,rows))
 def test_budget_enforced(self):
  rows=sample();rows[0]['latency_ms']=999000;self.assertTrue(e.validate(M,rows))
 def test_hash_mismatch_excluded(self):
  rows=sample();rows[0]['reference_sha256']='b'*64;self.assertEqual(e.summarize(M,rows)['matched_pairs_included'],1)
 def test_infra_cannot_be_site_failure(self):
  rows=sample(12,True,False);r=next(r for r in rows if r['mode']=='native_cloud_chrome');r['failure_stage']='dns';r['failure_attribution']='infrastructure';self.assertTrue(e.validate(M,rows))
 def test_unknown_attribution_excluded(self):
  rows=sample(2,False,False);rows[0]['failure_attribution']='unknown';self.assertEqual(e.summarize(M,rows)['matched_pairs_included'],1)
 def test_overlap_excluded(self):
  rows=sample();pair=[r for r in rows if r['pair_id']==rows[0]['pair_id']];pair[1]['started_at_utc']=pair[0]['started_at_utc'];pair[1]['ended_at_utc']=pair[0]['ended_at_utc'];self.assertEqual(e.summarize(M,rows)['matched_pairs_included'],1)
 def test_actual_order_controls_balance(self):
  rows=sample(12,True,False)
  for r in rows:
   t=dt.datetime(2026,10,12+r['repeat']%3,12,r['repeat']*2+(1 if r['mode']=='native_cloud_chrome' else 2),tzinfo=dt.timezone.utc);r['started_at_utc']=t.isoformat();r['ended_at_utc']=(t+dt.timedelta(seconds=10)).isoformat();r['availability']['checked_at_utc']=t.isoformat()
  s=e.summarize(M,rows)['routing'][0];self.assertEqual(s['order_counts']['native_first'],12);self.assertEqual(s['recommendation'],'insufficient_evidence')
 def test_timestamp_normalizes_utc(self):self.assertEqual(e.timestamp('2026-10-12T23:30:00-02:00').date().isoformat(),'2026-10-13')
 def test_extra_sampling_is_exploratory(self):self.assertEqual(e.summarize(M,sample(13,True,False))['routing'][0]['recommendation'],'insufficient_evidence')

 def test_native_http_rejected(self):
  rows=sample();next(r for r in rows if r['mode']=='native_cloud_chrome')['execution']['actual_rendering']='http';self.assertTrue(e.validate(M,rows))
 def test_false_failure_rejected(self):
  rows=sample(12,True,False);r=next(r for r in rows if r['mode']=='native_cloud_chrome');r['checks']={k:'pass' for k in r['checks']};self.assertTrue(e.validate(M,rows))
 def test_unattributed_failure_rejected(self):
  rows=sample(12,True,False);r=next(r for r in rows if r['mode']=='native_cloud_chrome');r.update(failure_attribution='none',failure_stage='none',failure_detail=None);self.assertTrue(e.validate(M,rows))
if __name__=='__main__':unittest.main()


