#!/usr/bin/env python3
"""Offline eval planning, validation and analysis. No network or browser automation."""
import argparse, collections, datetime as dt, hashlib, json, math, pathlib, random, statistics, sys
ROOT=pathlib.Path(__file__).resolve().parent
STATES={'not_run','blocked','unsupported','completed'}
RESULTS={'unassessed','pass','partial','fail'}
STAGES={'none','dns','tls','connector_transport','page_access','bot_challenge','render','extraction','interaction','download','auth','handoff','unknown'}

def read_json(path): return json.loads(pathlib.Path(path).read_text())
def read_jsonl(path): return [json.loads(x) for x in pathlib.Path(path).read_text().splitlines() if x.strip()]
def write_jsonl(rows,path): pathlib.Path(path).write_text(''.join(json.dumps(x,sort_keys=True)+'\n' for x in rows))
def digest(obj): return hashlib.sha256(json.dumps(obj,sort_keys=True).encode()).hexdigest()
def number(v): return isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)
def integer(v): return isinstance(v,int) and not isinstance(v,bool)
def valid_hash(v): return isinstance(v,str) and len(v)==64 and all(c in '0123456789abcdef' for c in v)
def timestamp(s):
 v=dt.datetime.fromisoformat(s.replace('Z','+00:00'))
 if not v.tzinfo: raise ValueError('timezone required')
 return v.astimezone(dt.timezone.utc)

def template(case,mode,pair_id,position,repeat,seed,manifest_hash,profile):
 return {'schema_version':'1.0','trial_id':f'{pair_id}-{position}','observation_provenance_id':None,'pair_id':pair_id,'case_id':case['id'],'mode':mode,'paired_modes':case['eligible_modes'],'profile':profile,'repeat':repeat,'planned_position':position,'seed':seed,'manifest_sha256':manifest_hash,'planned_url':case['url'],'final_url':None,'state':'not_run','task_result':'unassessed','failure_stage':'none','failure_attribution':'none','failure_detail':None,'checks':{k:'unassessed' for k in case['required_checks']},'reference_id':None,'reference_sha256':None,'condition_key':'unconfigured','comparability':'unknown','started_at_utc':None,'ended_at_utc':None,'budget_seconds':case['budget_seconds'],'latency_ms':None,'time_to_first_useful_content_ms':None,'tool_calls':None,'retry_count':0,'user_interventions':None,'user_active_seconds':None,'cost_amount':None,'cost_currency':None,'cost_observation_source':None,'cost_comparable':False,'execution':{'environment':None,'tool_version':None,'browser_version':None,'browser_build':None,'headless':None,'viewport':None,'locale':None,'region':None,'profile_alias':None,'auth_state':'unknown','cache_state':'unknown','session_age_seconds':None,'job_or_tab_id':None,'actual_rendering':None,'surface_verified':False,'prerequisites_verified':False,'isolation_verified':False},'availability':{'connector_ok':None,'browser_ok':None,'control_ok':None,'evidence_id':None,'checked_at_utc':None,'post_failure_control_ok':None},'evidence':[],'download':{'mime_type':None,'sniffed_format':None,'bytes':None,'sha256':None,'readable':None},'interruption':None,'gate_authorization_reference':None,'fidelity':{'expected_units':None,'correct_units':None,'incorrect_units':None,'omitted_units':None,'reference_complete':None},'first_attempt_result':'unassessed','timeout':False,'scorer':{'id':None,'blinded_to_mode':None,'adjudication_at_utc':None},'protocol_deviations':[],'observer_notes':None}

def plan(manifest,seed,repeats,pilot=True,profile=None):
 if repeats<1: raise ValueError('repeats must be >=1')
 rng=random.Random(seed); output=[]; h=digest(manifest)
 selected=[c for c in manifest['cases'] if not c['gate'] and c['url'] and (c['pilot'] or not pilot)]
 starts={c['id']:rng.randrange(2) for c in selected}
 for repeat in range(1,repeats+1):
  batch=selected[:]; rng.shuffle(batch)
  for c in batch:
   p=profile or c['profiles'][0]
   if p not in manifest['profiles']: raise ValueError('unknown profile')
   # Profile overrides are design requests; readiness must verify they really exist.
   modes=list(c['eligible_modes'])
   if len(modes)!=2: raise ValueError('primary schedule expects two arms per case')
   if (starts[c['id']]+repeat)%2: modes.reverse()
   pair=f"s{seed}-{c['id']}-{p}-r{repeat:03}"
   output += [template(c,m,pair,i,repeat,seed,h,p) for i,m in enumerate(modes,1)]
 return output

def validate(manifest,rows):
 errors=[]; seen=set(); slots=set(); provenances=set(); cases={c['id']:c for c in manifest['cases']}
 for r in rows:
  tid=r.get('trial_id','<missing>'); prefix=lambda s:f'{tid}: {s}'
  if tid in seen: errors.append(prefix('duplicate trial_id'))
  seen.add(tid)
  slot=tuple(r.get(k) for k in ['seed','case_id','profile','repeat','mode','manifest_sha256'])
  if slot in slots: errors.append(prefix('duplicate planned slot'))
  slots.add(slot)
  provenance=r.get('observation_provenance_id')
  if provenance and provenance in provenances: errors.append(prefix('reused observation provenance'))
  if provenance: provenances.add(provenance)
  c=cases.get(r.get('case_id'))
  if c is None: errors.append(prefix('unknown case')); continue
  if r.get('state') not in STATES: errors.append(prefix('invalid state'))
  if r.get('task_result') not in RESULTS: errors.append(prefix('invalid task result'))
  if r.get('failure_stage') not in STAGES: errors.append(prefix('invalid failure stage'))
  if r.get('mode') not in c['eligible_modes']: errors.append(prefix('mode not eligible for primary case'))
  if set(r.get('paired_modes',[]))!=set(c['eligible_modes']): errors.append(prefix('paired_modes mismatch'))
  if r.get('failure_attribution') not in {'none','task_path','infrastructure','capability','policy','unknown'}: errors.append(prefix('invalid failure attribution'))
  if r.get('profile') not in manifest['profiles']: errors.append(prefix('invalid profile'))
  if r.get('manifest_sha256')!=digest(manifest): errors.append(prefix('manifest hash mismatch'))
  if r.get('planned_url')!=c['url']: errors.append(prefix('planned URL mismatch'))
  checks=r.get('checks',{})
  if set(checks)!=set(c['required_checks']): errors.append(prefix('required checks differ from manifest'))
  if any(v not in {'pass','fail','unassessed','not_applicable'} for v in checks.values()): errors.append(prefix('invalid check value'))
  if r.get('state')!='completed' and r.get('task_result')!='unassessed': errors.append(prefix('unexecuted/blocked cannot be site failure or pass'))
  if r.get('task_result')=='pass' and (not checks or any(x!='pass' for x in checks.values())): errors.append(prefix('pass requires every required check to pass'))
  if r.get('task_result')=='pass' and (r.get('failure_stage')!='none' or r.get('failure_attribution')!='none'): errors.append(prefix('pass cannot have a failure stage or attribution'))
  if r.get('task_result') in {'fail','partial'}:
   if checks and all(v=='pass' for v in checks.values()): errors.append(prefix('all checks passed but aggregate task did not'))
   if r.get('failure_stage')=='none' or not r.get('failure_detail') or r.get('failure_attribution') not in {'task_path','unknown'}: errors.append(prefix('task failure needs observed stage, detail and attribution'))
   if r.get('task_result')=='partial' and not any(v=='pass' for v in checks.values()): errors.append(prefix('partial result needs at least one completed check'))
  if r.get('budget_seconds')!=c['budget_seconds']: errors.append(prefix('case budget mismatch'))
  if not integer(r.get('retry_count')) or r['retry_count']<0: errors.append(prefix('invalid retry count'))
  if r.get('state')=='completed':
   if not c['url']: errors.append(prefix('unresolved target cannot be completed'))
   if not provenance: errors.append(prefix('executed trial needs immutable observation provenance'))
   if not valid_hash(r.get('reference_sha256')): errors.append(prefix('valid reference SHA-256 required'))
   ex=r.get('execution',{})
   for f in ['environment','tool_version','profile_alias','auth_state','cache_state','actual_rendering']:
    if ex.get(f) in {None,'','unknown'}: errors.append(prefix('verified execution metadata required: '+f))
   if ex.get('surface_verified') is not True or ex.get('prerequisites_verified') is not True: errors.append(prefix('execution surface and prerequisites must be verified'))
   if r.get('mode') in {'native_cloud_chrome','patronus_reader_browser','patronus_desktop'} and ex.get('actual_rendering')!='browser': errors.append(prefix('forced-browser arm did not verify browser rendering'))
   if r.get('profile') in {'cold_public','warm_public'} and ex.get('isolation_verified') is not True: errors.append(prefix('isolated profile unverified'))
   if r.get('profile')=='warm_authenticated' and ex.get('auth_state')!='authenticated': errors.append(prefix('warm authenticated state unverified'))
   if r.get('profile') in {'cold_public','warm_public'} and ex.get('auth_state')!='logged_out': errors.append(prefix('public auth prerequisites not met'))
   if r.get('failure_attribution') in {'infrastructure','capability','policy'}: errors.append(prefix('infrastructure/capability/policy result is blocked or unsupported, not completed'))
   if r.get('task_result')=='unassessed': errors.append(prefix('completed trial needs adjudicated result'))
   if not r.get('evidence'): errors.append(prefix('executed trial needs evidence'))
   if not r.get('reference_id'): errors.append(prefix('completed trial needs ground-truth reference'))
   if r.get('first_attempt_result') not in {'pass','partial','fail'}: errors.append(prefix('completed trial needs first attempt outcome'))
   if not r.get('scorer',{}).get('id'): errors.append(prefix('completed trial needs scorer id'))
   if r.get('condition_key') in {None,'','unconfigured'}: errors.append(prefix('completed trial needs condition key'))
   if c['gate'] and not r.get('gate_authorization_reference'): errors.append(prefix('gated trial lacks authorization reference'))
   for f in ['latency_ms','tool_calls','user_interventions','user_active_seconds']:
    if not number(r.get(f)) or r[f]<0: errors.append(prefix(f+' must be measured and nonnegative'))
   for f in ['tool_calls','user_interventions']:
    if not integer(r.get(f)): errors.append(prefix(f+' must be an integer'))
   if number(r.get('latency_ms')) and r['latency_ms']>c['budget_seconds']*1000: errors.append(prefix('task budget exceeded'))
   if r.get('timeout') and r.get('task_result')=='pass': errors.append(prefix('timeout cannot pass'))
   try:
    span=(timestamp(r['ended_at_utc'])-timestamp(r['started_at_utc'])).total_seconds()*1000
    if number(r.get('latency_ms')) and abs(span-r['latency_ms'])>1000: errors.append(prefix('latency disagrees with timestamps'))
    if timestamp(r['ended_at_utc'])<timestamp(r['started_at_utc']): errors.append(prefix('timestamps reversed'))
   except (ValueError,TypeError,KeyError): errors.append(prefix('valid zoned start/end timestamps required'))
   if r.get('failure_stage')=='connector_transport': errors.append(prefix('connector outage must be blocked, not completed'))
  if r.get('state')=='blocked' and not r.get('failure_detail'): errors.append(prefix('blocked trial needs explanation'))
  if r.get('cost_amount') is not None and (not r.get('cost_currency') or not r.get('cost_observation_source')): errors.append(prefix('cost needs currency and observable source'))
  if r.get('cost_amount') is not None and (not number(r['cost_amount']) or r['cost_amount']<0): errors.append(prefix('negative cost'))
  if r.get('tool_calls') is not None and r['tool_calls']>manifest['design']['max_tool_calls_per_arm'] and not r.get('protocol_deviations'): errors.append(prefix('tool-call budget exceeded without protocol deviation'))
  if integer(r.get('retry_count')) and r['retry_count']>manifest['design']['max_navigation_retries']: errors.append(prefix('retry budget exceeded; record protocol deviation'))
  if r.get('task_result')=='pass' and c['suite']=='files':
   d=r.get('download',{})
   if d.get('readable') is not True or not valid_hash(d.get('sha256')) or not integer(d.get('bytes')) or not 0<d['bytes']<=c.get('max_bytes',manifest['design']['max_download_bytes']): errors.append(prefix('download pass needs readable bytes, hash and byte count'))
 return errors

def wilson(k,n):
 if not n:return None
 z=1.959963984540054; p=k/n; d=1+z*z/n
 center=(p+z*z/(2*n))/d; half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
 return [round(center-half,4),round(center+half,4)]
def mcnemar(b,c):
 n=b+c
 return min(1.0,2*sum(math.comb(n,k) for k in range(min(b,c)+1))/(2**n)) if n else 1.0

def summarize(manifest,rows):
 errors=validate(manifest,rows)
 if errors: raise ValueError('\n'.join(errors))
 counts=dict(collections.Counter(r['state'] for r in rows)); pairs=collections.defaultdict(list); groups=collections.defaultdict(list); excluded=[]
 for r in rows:pairs[r['pair_id']].append(r)
 for pid,rr in pairs.items():
  if len(rr)!=2 or len({r['mode'] for r in rr})!=2: excluded.append({'pair_id':pid,'reason':'missing or duplicate arm'});continue
  if any(r['state']!='completed' for r in rr):excluded.append({'pair_id':pid,'reason':'not two completed site-task attempts'});continue
  if any(r['comparability']!='matched' for r in rr):excluded.append({'pair_id':pid,'reason':'session or task prerequisites not matched'});continue
  fields=['case_id','profile','condition_key','reference_id','reference_sha256','manifest_sha256']
  if any(rr[0][f]!=rr[1][f] for f in fields):excluded.append({'pair_id':pid,'reason':'stratum or reference mismatch'});continue
  if abs((timestamp(rr[0]['started_at_utc'])-timestamp(rr[1]['started_at_utc'])).total_seconds())>manifest['design']['same_pair_max_gap_seconds']:excluded.append({'pair_id':pid,'reason':'pair time gap exceeded'});continue
  if any(r['availability'].get(k) is not True for r in rr for k in ['connector_ok','browser_ok','control_ok']):excluded.append({'pair_id':pid,'reason':'healthy preflight not verified for both arms'});continue
  if any(r.get('failure_attribution')=='unknown' for r in rr):excluded.append({'pair_id':pid,'reason':'failure attribution unknown'});continue
  if any(r['failure_stage'] in {'dns','tls','render'} and r['task_result']!='pass' and r['availability'].get('post_failure_control_ok') is not True for r in rr):excluded.append({'pair_id':pid,'reason':'ambiguous failure lacks contemporaneous control'});continue
  try:
   if any(not r['availability'].get('evidence_id') or not 0<=(timestamp(r['started_at_utc'])-timestamp(r['availability']['checked_at_utc'])).total_seconds()<=300 for r in rr):excluded.append({'pair_id':pid,'reason':'preflight evidence not contemporaneous'});continue
  except (ValueError,TypeError,KeyError):excluded.append({'pair_id':pid,'reason':'preflight evidence missing timestamp'});continue
  early,late=sorted(rr,key=lambda x:timestamp(x['started_at_utc']))
  if timestamp(early['ended_at_utc'])>=timestamp(late['started_at_utc']):excluded.append({'pair_id':pid,'reason':'arms overlap or simultaneous start'});continue
  if any(r.get('protocol_deviations') for r in rr):excluded.append({'pair_id':pid,'reason':'protocol deviation requires separate stratum and review'});continue
  key=(rr[0]['case_id'],rr[0]['profile'],rr[0]['condition_key'])
  groups[key].append(rr)
 # Conservative multiplicity count includes all resolved primary cases, including not yet observed.
 family=max(1,len([c for c in manifest['cases'] if c['url'] and not c['gate']]))
 family=max(family,len(groups))
 output=[]
 for key,ps in sorted(groups.items()):
  a=[];b=[];patronus=[];native=[];dates=set();ab=ba=0
  for rr in ps:
   n=next(r for r in rr if r['mode']=='native_cloud_chrome'); p=next(r for r in rr if r['mode'].startswith('patronus_'))
   native.append(n);patronus.append(p);a.append(n['task_result']=='pass');b.append(p['task_result']=='pass');dates.add(timestamp(n['started_at_utc']).date().isoformat())
   if timestamp(n['started_at_utc'])<timestamp(p['started_at_utc']):ab+=1
   else:ba+=1
  n=len(ps);pw=sum(y and not x for x,y in zip(a,b));nw=sum(x and not y for x,y in zip(a,b));d=(sum(b)-sum(a))/n;pval=mcnemar(pw,nw);adj=min(1,pval*family)
  enough=n==manifest['design']['routing_target_pairs'] and len(dates)>=manifest['design']['routing_min_utc_dates'] and min(ab,ba)>=n//3
  meaningful=abs(d)>=manifest['design']['routing_min_absolute_completion_gain']
  recommendation='insufficient_evidence';confidence='none' if n<2 else 'exploratory'
  if enough:
   confidence='moderate_for_this_case_and_condition_only'
   if meaningful and adj<=manifest['design']['familywise_alpha']:recommendation='patronus_first' if d>0 else 'native_first'
   elif sum(a)==n and sum(b)==n:recommendation='both_complete_no_accuracy_winner'
   else:recommendation='no_clear_winner'
  def metrics(arm):
   passed=[r for r in arm if r['task_result']=='pass']; times=[r['latency_ms'] for r in passed]
   observed=[r for r in arm if r['cost_amount'] is not None]
   return {'passes':len(passed),'attempts':len(arm),'completion_rate':len(passed)/len(arm),'descriptive_wilson_95':wilson(len(passed),len(arm)),'successful_latency_median_ms':statistics.median(times) if times else None,'successful_latency_p95_ms':sorted(times)[math.ceil(.95*len(times))-1] if len(times)>=20 else None,'latency_p95_minimum_n':20,'median_tool_calls':statistics.median(r['tool_calls'] for r in arm),'interventions_total':sum(r['user_interventions'] for r in arm),'user_active_seconds_total':sum(r['user_active_seconds'] for r in arm),'cost_observed_trials':len(observed),'cost_total':sum(r['cost_amount'] for r in observed) if len(observed)==len(arm) and len({r['cost_currency'] for r in observed})==1 and all(r['cost_comparable'] for r in observed) else None,'currency':observed[0]['cost_currency'] if observed and len({r['cost_currency'] for r in observed})==1 else None}
  joint=[(x,y) for x,y in zip(native,patronus) if x['task_result']=='pass' and y['task_result']=='pass']
  paired_speed={'both_success_n':len(joint),'median_patronus_minus_native_ms':statistics.median(y['latency_ms']-x['latency_ms'] for x,y in joint) if joint else None,'median_patronus_native_ratio':statistics.median(y['latency_ms']/x['latency_ms'] for x,y in joint if x['latency_ms']>0) if any(x['latency_ms']>0 for x,y in joint) else None}
  output.append({'paired_success_latency':paired_speed,'case_id':key[0],'profile':key[1],'condition_key':key[2],'paired_samples':n,'utc_dates':sorted(dates),'order_counts':{'native_first':ab,'patronus_first':ba},'patronus_only_pass':pw,'native_only_pass':nw,'both_pass':sum(x and y for x,y in zip(a,b)),'neither_pass':sum(not x and not y for x,y in zip(a,b)),'patronus_minus_native_completion':d,'mcnemar_two_sided_p':pval,'bonferroni_adjusted_p':adj,'comparison_family_size':family,'recommendation':recommendation,'confidence':confidence,'native':metrics(native),'patronus':metrics(patronus)})
 operational={}
 for mode in sorted({r['mode'] for r in rows}):
  subset=[r for r in rows if r['mode']==mode]
  operational[mode]={'recorded_opportunities':len(subset),'states':dict(collections.Counter(r['state'] for r in subset)),'failure_attributions':dict(collections.Counter(r['failure_attribution'] for r in subset)),'first_attempt_passes':sum(r['first_attempt_result']=='pass' for r in subset),'final_passes':sum(r['task_result']=='pass' for r in subset)}
 return {'schema_version':'1.0','recommendations_conditional_on':'healthy matched execution at the preregistered final sample size','operational_by_mode':operational,'state_counts':counts,'matched_pairs_included':sum(len(x) for x in groups.values()),'excluded_pairs':excluded,'routing':output,'cautions':['Repeated trials of one domain are not independent evidence across the web.','Latency summaries are conditional on successful completion; inspect failure timeouts separately.','Current outage and not-run rows are never site-task failures.','Per-case recommendations do not establish an engine-only causal effect.']}

def main():
 p=argparse.ArgumentParser(description=__doc__); p.add_argument('--manifest',default=str(ROOT/'manifest.json')); sub=p.add_subparsers(dest='cmd',required=True)
 q=sub.add_parser('plan');q.add_argument('--seed',type=int,default=10112026);q.add_argument('--repeats',type=int,default=2);q.add_argument('--all-public',action='store_true');q.add_argument('--profile',default=None);q.add_argument('--out',required=True)
 q=sub.add_parser('validate');q.add_argument('observations')
 q=sub.add_parser('summarize');q.add_argument('observations');q.add_argument('--out',required=True)
 a=p.parse_args();m=read_json(a.manifest)
 try:
  if a.cmd=='plan':
   rr=plan(m,a.seed,a.repeats,not a.all_public,a.profile);write_jsonl(rr,a.out);print(json.dumps({'planned_arms':len(rr),'planned_pairs':len(rr)//2,'out':a.out,'execution':'none'}))
  elif a.cmd=='validate':
   errors=validate(m,read_jsonl(a.observations));print(json.dumps({'valid':not errors,'errors':errors},indent=2));return 1 if errors else 0
  else:
   result=summarize(m,read_jsonl(a.observations));pathlib.Path(a.out).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'matched_pairs':result['matched_pairs_included'],'out':a.out}))
 except (ValueError,KeyError,TypeError) as e:print(str(e),file=sys.stderr);return 1
 return 0
if __name__=='__main__':sys.exit(main())
