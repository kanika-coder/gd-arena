/*
 * GD Arena engine — shared by the WebSocket server (Node) and the browser's offline fallback.
 * Pure logic: topics, AI personas, rule-based scoring and the adaptive session state machine.
 * A Session talks to the outside world only through emit(event) and schedule(fn, ms).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GDEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Participants                                                        */
  /* ------------------------------------------------------------------ */
  const PARTICIPANTS = {
    aarav: { id: 'aarav', name: 'Aarav', role: 'Analyst', color: '#7AA8FF', gender: 'm',
      trait: 'Wants data and structure behind every claim.', voice: { pitch: 0.92, rate: 1.0 } },
    riya: { id: 'riya', name: 'Riya', role: 'Challenger', color: '#FF7A6B', gender: 'f',
      trait: 'Attacks weak claims head-on.', voice: { pitch: 1.12, rate: 1.06 } },
    kabir: { id: 'kabir', name: 'Kabir', role: 'Collaborator', color: '#43D9B0', gender: 'm',
      trait: 'Builds on ideas and pulls people in.', voice: { pitch: 1.0, rate: 0.96 } },
    meera: { id: 'meera', name: 'Meera', role: "Devil's Advocate", color: '#C49BFF', gender: 'f',
      trait: 'Argues the opposite side on purpose.', voice: { pitch: 1.04, rate: 1.02 } }
  };
  const PIDS = Object.keys(PARTICIPANTS);

  /* ------------------------------------------------------------------ */
  /* Skills                                                              */
  /* ------------------------------------------------------------------ */
  const SKILLS = {
    content: { name: 'Content', strength: 'Relevant arguments', improve: 'Depth of topic knowledge' },
    reasoning: { name: 'Reasoning', strength: 'Logical reasoning', improve: 'Explaining the “why” behind claims' },
    evidence: { name: 'Evidence', strength: 'Good examples', improve: 'Backing claims with examples' },
    counter: { name: 'Counterargument', strength: 'Handles opposing views', improve: 'Responding to opposing views' },
    leadership: { name: 'Leadership', strength: 'Steers the discussion', improve: 'Leadership' },
    participation: { name: 'Participation', strength: 'Active participation', improve: 'Entering the discussion' },
    communication: { name: 'Communication', strength: 'Clear communication', improve: 'Clarity and structure' },
    confidence: { name: 'Confidence', strength: 'Confident delivery', improve: 'Fewer fillers and hedges' },
    listening: { name: 'Active Listening', strength: 'Builds on what others say', improve: 'Referencing others’ points' }
  };
  const REPORT_SKILLS = ['content', 'reasoning', 'communication', 'leadership', 'counter', 'participation'];
  const PROFILE_SKILLS = ['leadership', 'confidence', 'reasoning', 'communication', 'participation', 'listening'];
  const WEAKNESS_SKILLS = ['participation', 'counter', 'evidence', 'reasoning', 'leadership'];
  const WEAKNESS_LABEL = {
    participation: 'PARTICIPATION', counter: 'COUNTERARGUMENTS', evidence: 'EVIDENCE',
    reasoning: 'REASONING', leadership: 'LEADERSHIP'
  };

  /* ------------------------------------------------------------------ */
  /* Topics                                                              */
  /* ------------------------------------------------------------------ */
  const TOPICS = [
    {
      id: 'ai', cat: 'Technology', title: 'Is AI going to replace jobs?', difficulty: 'Hard', mins: 15,
      skills: ['Counterargument', 'Evidence', 'Reasoning'], featured: true,
      lex: ['ai', 'automation', 'automate', 'automated', 'jobs', 'job', 'employment', 'workers', 'workforce', 'reskilling', 'reskill', 'upskilling', 'retrain', 'skills', 'productivity', 'tasks', 'routine', 'chatbots', 'chatbot', 'displacement', 'wages', 'economy', 'demand', 'roles', 'training', 'technology', 'tools', 'companies', 'careers', 'data entry', 'customer support', 'colleges'],
      aKeys: ['create', 'creates', 'new jobs', 'new roles', 'transform', 'augment', 'assist', 'complement', 'opportunities', 'opportunity'],
      bKeys: ['replace', 'replaced', 'lose', 'losing', 'loss', 'unemployment', 'displace', 'threat', 'eliminate', 'at risk', 'painful'],
      A: ['AI usually automates tasks inside a job, not the whole job, so most roles get redesigned rather than removed.',
        'Every big technology wave, from computers to the internet, ended up creating more work than it removed.',
        'Cheaper AI tools let small businesses do things they could never afford before, and that creates demand for people.'],
      B: ['This wave is faster than earlier ones, and people in data entry or customer support cannot retrain overnight.',
        'Even when new jobs appear, they need very different skills and often appear in different cities.',
        'AI can now write code, draft contracts and read scans, so white-collar jobs are exposed for the first time.'],
      facts: ['the World Economic Forum’s Future of Jobs 2025 report projects about 170 million roles created and 92 million displaced by 2030',
        'after ATMs spread in the US, the number of bank tellers kept rising for years because branches became cheaper to run',
        'IT firms such as Infosys and TCS have put hundreds of thousands of employees through AI training'],
      opening: {
        aarav: 'Let me frame it with numbers. The World Economic Forum expects around 170 million roles to be created by 2030 and about 92 million displaced. So the question is really who gets the new jobs.',
        riya: 'Those are projections, not paychecks. Customer support and data entry roles are shrinking right now, and those people cannot become machine learning engineers overnight.',
        kabir: 'Both points can be true. Maybe we should separate the short-term disruption from the long-term picture, and treat reskilling as the bridge between them.',
        meera: 'I will take the uncomfortable side. If a model can write code, draft contracts and read X-rays, then no white-collar job is truly safe.'
      },
      counterClaim: { A: 'Some students argue that AI will create more jobs than it destroys. Respond to this argument.',
        B: 'Some students argue that AI will destroy far more jobs than it creates. Respond to this argument.' },
      fallacy: 'AI can already write code, so programmers are finished. It is that simple.'
    },
    {
      id: 'ev', cat: 'Technology', title: 'Can electric vehicles replace petrol cars in India by 2035?', difficulty: 'Medium', mins: 12,
      skills: ['Evidence', 'Reasoning', 'Content'],
      lex: ['ev', 'evs', 'electric', 'vehicles', 'petrol', 'battery', 'batteries', 'charging', 'subsidy', 'subsidies', 'pollution', 'emissions', 'grid', 'coal', 'two-wheelers', 'infrastructure', 'cost', 'range', 'renewable', 'policy'],
      aKeys: ['can', 'will', 'cheaper', 'subsidy', 'clean', 'pollution', 'falling', 'possible'],
      bKeys: ['cannot', "can't", "won't", 'unrealistic', 'infrastructure', 'expensive', 'coal', 'range', 'not ready'],
      A: ['Two-wheelers and three-wheelers are going electric fast, and that is where most Indian vehicles are.',
        'Battery prices have fallen sharply over the last decade, which keeps narrowing the price gap.',
        'EVs cut street-level air pollution, which is a major public health problem in Indian cities.'],
      B: ['Public charging is still thin outside big cities and highways.',
        'Much of India’s electricity still comes from coal, so EVs shift emissions rather than remove them.',
        'Electric cars still cost more upfront than petrol cars for most middle-class buyers.'],
      facts: ['electric two- and three-wheelers already make up a far bigger share of new sales in India than electric cars',
        'the PM E-DRIVE scheme subsidises electric two-wheelers, three-wheelers, buses and charging stations',
        'coal still generates the largest share of India’s electricity'],
      counterClaim: { A: 'Some students argue that EVs can fully replace petrol cars in India by 2035. Respond to this argument.',
        B: 'Some students argue that India will not be ready for EVs for decades. Respond to this argument.' },
      fallacy: 'Electric cars are expensive today, so they will always be too expensive for Indians.'
    },
    {
      id: 'startup', cat: 'Business', title: 'Startups vs MNCs: where should freshers begin?', difficulty: 'Easy', mins: 10,
      skills: ['Reasoning', 'Evidence', 'Leadership'],
      lex: ['startup', 'startups', 'mnc', 'mncs', 'freshers', 'career', 'ownership', 'equity', 'stability', 'training', 'brand', 'layoffs', 'learning', 'mentorship', 'salary', 'risk', 'growth', 'process'],
      aKeys: ['startup', 'startups', 'ownership', 'faster', 'responsibility', 'equity', 'impact'],
      bKeys: ['mnc', 'mncs', 'stability', 'structure', 'training', 'brand', 'security', 'process'],
      A: ['At a startup, freshers get real ownership in months instead of years.',
        'You learn several roles at once because small teams cannot afford narrow job descriptions.',
        'Early employees can get equity, which pays off if the company grows.'],
      B: ['MNCs offer structured training that builds strong fundamentals.',
        'Many startups shut down or cut staff, and that risk is hard to absorb in a first job.',
        'A big brand name on your CV makes the next job search easier.'],
      facts: ['large IT services firms run training programmes for freshers that last weeks or months before deployment',
        'funding slowdowns in recent years led many Indian startups to announce layoffs',
        'early employees at companies such as Flipkart and Zomato benefited from stock options'],
      counterClaim: { A: 'Some students argue that freshers should always start at a startup. Respond to this argument.',
        B: 'Some students argue that freshers should always start at an MNC for stability. Respond to this argument.' },
      fallacy: 'Most startups fail, so joining any startup is a mistake.'
    },
    {
      id: 'wfh', cat: 'Business', title: 'Is work from home the future of work?', difficulty: 'Medium', mins: 12,
      skills: ['Counterargument', 'Communication', 'Evidence'],
      lex: ['remote', 'work from home', 'wfh', 'office', 'hybrid', 'commute', 'commuting', 'flexibility', 'collaboration', 'mentoring', 'culture', 'productivity', 'talent', 'isolation', 'balance', 'teams', 'managers'],
      aKeys: ['remote', 'work from home', 'wfh', 'flexibility', 'commute', 'talent', 'balance'],
      bKeys: ['office', 'collaboration', 'mentoring', 'culture', 'isolation', 'distraction', 'in person', 'return'],
      A: ['Remote work saves hours of commuting every week.',
        'Companies can hire talent from any city, not only from the metros.',
        'Many people get better work-life balance when they control their own schedule.'],
      B: ['Junior employees learn faster by watching seniors in person.',
        'Spontaneous collaboration and culture are harder to build over video calls.',
        'Many large firms have asked employees to come back to the office several days a week.'],
      facts: ['GitLab has run as a fully remote company with staff in dozens of countries',
        'several large companies, including Amazon, have ordered employees back to the office',
        'many Indian IT firms now follow a hybrid policy with a few office days each week'],
      counterClaim: { A: 'Some students argue that remote work is better than the office for everyone. Respond to this argument.',
        B: 'Some students argue that return-to-office mandates prove remote work has failed. Respond to this argument.' },
      fallacy: 'People at home get distracted, so remote workers are always less productive.'
    },
    {
      id: 'social', cat: 'Society', title: 'Social media: benefit or threat?', difficulty: 'Easy', mins: 10,
      skills: ['Counterargument', 'Evidence', 'Listening'],
      lex: ['social media', 'platforms', 'misinformation', 'fake news', 'mental health', 'privacy', 'data', 'creators', 'awareness', 'addiction', 'algorithms', 'teenagers', 'youth', 'community', 'regulation', 'screen time'],
      aKeys: ['benefit', 'connect', 'voice', 'awareness', 'business', 'creators', 'community', 'opportunity'],
      bKeys: ['threat', 'addiction', 'misinformation', 'fake news', 'mental health', 'privacy', 'cyberbullying', 'polarisation'],
      A: ['Social media lets small businesses and creators reach customers without big budgets.',
        'It gives ordinary people a voice and spreads awareness quickly during emergencies.',
        'It keeps families and friends connected across cities and countries.'],
      B: ['Misinformation spreads faster than corrections.',
        'Feeds are designed to keep people scrolling, which hurts focus and sleep.',
        'Personal data is collected and monetised, often without users understanding it.'],
      facts: ['India has hundreds of millions of social media users, among the most of any country',
        'WhatsApp limited message forwarding in India to slow the spread of rumours',
        'Australia has moved to restrict social media accounts for children under 16'],
      counterClaim: { A: 'Some students argue that social media does far more good than harm. Respond to this argument.',
        B: 'Some students argue that social media is a net threat to society. Respond to this argument.' },
      fallacy: 'Some people get addicted to social media, so everyone who uses it is harmed.'
    },
    {
      id: 'college', cat: 'Education', title: 'Should college education be mandatory?', difficulty: 'Medium', mins: 12,
      skills: ['Reasoning', 'Counterargument', 'Leadership'],
      lex: ['college', 'degree', 'education', 'mandatory', 'employers', 'skills', 'vocational', 'apprenticeship', 'online courses', 'cost', 'fees', 'nep', 'students', 'universities', 'jobs', 'employability'],
      aKeys: ['mandatory', 'must', 'degree', 'foundation', 'critical thinking', 'employability', 'structured'],
      bKeys: ['not mandatory', 'choice', 'vocational', 'cost', 'debt', 'self-taught', 'alternative', 'online courses'],
      A: ['A degree builds foundations in thinking and communication that short courses do not.',
        'Many employers still use a degree as the first filter for jobs.',
        'College exposes students to people and ideas beyond their hometown.'],
      B: ['Not everyone learns best in a classroom, and vocational paths can lead to good careers.',
        'Making college mandatory would raise costs for families who cannot afford it.',
        'Many skills employers want can now be learned through apprenticeships and online courses.'],
      facts: ['India’s National Education Policy 2020 allows multiple entry and exit points in undergraduate degrees',
        'several large tech firms have dropped degree requirements for some roles',
        'India’s gross enrolment ratio in higher education is still under 30 percent'],
      counterClaim: { A: 'Some students argue that every young person must go to college. Respond to this argument.',
        B: 'Some students argue that college is a waste of time in the age of online courses. Respond to this argument.' },
      fallacy: 'Some dropouts became billionaires, so college is unnecessary.'
    },
    {
      id: 'coding', cat: 'Education', title: 'Should coding be compulsory for every student?', difficulty: 'Easy', mins: 10,
      skills: ['Reasoning', 'Evidence', 'Participation'],
      lex: ['coding', 'programming', 'compulsory', 'schools', 'students', 'teachers', 'logic', 'problem solving', 'digital literacy', 'curriculum', 'computers', 'careers', 'ai', 'syllabus'],
      aKeys: ['compulsory', 'should', 'logic', 'problem solving', 'digital', 'literacy', 'future'],
      bKeys: ['not compulsory', 'choice', 'teachers', 'burden', 'pressure', 'interest', 'infrastructure'],
      A: ['Coding teaches logical thinking and problem solving that help in every subject.',
        'Digital literacy is becoming as basic as reading and arithmetic.',
        'Early exposure helps students discover whether they enjoy technology careers.'],
      B: ['Many schools lack trained teachers and computers to teach coding well.',
        'Another compulsory subject adds pressure on students who already have a heavy syllabus.',
        'AI tools now write a lot of code, so problem solving matters more than syntax.'],
      facts: ['England made computing part of the national curriculum from age five in 2014',
        'India’s NEP 2020 recommends introducing coding from Class 6',
        'many government schools in India still lack working computer labs'],
      counterClaim: { A: 'Some students argue that coding should be as compulsory as maths. Respond to this argument.',
        B: 'Some students argue that coding is a niche skill and should never be compulsory. Respond to this argument.' },
      fallacy: 'AI can write code now, so nobody needs to learn coding.'
    },
    {
      id: 'fourday', cat: 'Current Affairs', title: 'Is a four-day work week right for India?', difficulty: 'Hard', mins: 15,
      skills: ['Counterargument', 'Evidence', 'Reasoning'],
      lex: ['four-day', 'work week', 'productivity', 'burnout', 'hours', 'employees', 'employers', 'wellbeing', 'labour', 'shift', 'manufacturing', 'output', 'costs', 'trial', 'trials', 'pilot', 'balance', 'retention', 'wages', 'economy'],
      aKeys: ['four-day', 'productivity', 'burnout', 'balance', 'wellbeing', 'trial', 'pilot', 'retention'],
      bKeys: ['manufacturing', 'shift', 'cost', 'output', 'small business', 'longer days', 'not ready', 'daily wages'],
      A: ['Trials abroad found many companies kept output steady with fewer days.',
        'Burnout is common in Indian offices, and rested employees work better.',
        'A shorter week helps companies attract and keep talent.'],
      B: ['Much of India’s economy runs on shifts and daily wages, where fewer days can mean less income.',
        'Small businesses may not afford the same output with fewer working days.',
        'Four longer days can be as tiring as five normal ones.'],
      facts: ['Iceland’s public-sector trials between 2015 and 2019 covered around 2,500 workers',
        'a UK pilot in 2022 involved 61 companies, and most kept the four-day week afterwards',
        'India’s labour codes allow weekly working hours to be spread over fewer days'],
      counterClaim: { A: 'Some students argue that a four-day week will make Indian workers more productive. Respond to this argument.',
        B: 'Some students argue that a four-day week would hurt India’s economy. Respond to this argument.' },
      fallacy: 'Fewer working days means less work done, so the economy will shrink.'
    }
  ];
  const CATEGORIES = ['Technology', 'Business', 'Society', 'Education', 'Current Affairs'];
  const TOPIC = Object.fromEntries(TOPICS.map(t => [t.id, t]));

  // Generic openings for topics without hand-written ones
  TOPICS.forEach(t => {
    if (t.opening) return;
    t.opening = {
      aarav: `Let me start with some evidence: ${t.facts[0]}. I would like us to argue from data, not just opinions.`,
      riya: `I will push back early. ${t.B[0]} Anyone on the other side needs to answer that.`,
      kabir: `I think both sides have a point. ${t.A[0]} But ${lowerFirst(t.B[1])} Can we weigh both?`,
      meera: `Let me argue the side people find uncomfortable. ${t.A[2]}`
    };
  });

  /* ------------------------------------------------------------------ */
  /* Demo script (AI topic) — used by "Try Demo"                         */
  /* ------------------------------------------------------------------ */
  const DEMO = {
    topicId: 'ai',
    turns: [
      'I believe AI will replace a large number of routine jobs before 2030. Tasks such as data entry, basic customer support and simple accounting are already being automated, so people in those roles are at real risk. This matters because many of them are early in their careers and have limited savings.',
      "It's true, as Riya said, that new roles will appear, but they need very different skills. For example, many Indian banks now answer routine queries with chatbots, and IT companies such as Infosys need fewer people for manual testing. Therefore the transition will be painful for workers who can't retrain quickly.",
      'We should focus on solutions, not just fear. Firstly, companies should fund reskilling for the employees they automate, because they keep the savings. Secondly, colleges need to teach AI tools in every course. I propose we discuss who should pay for this, so let us hear from Kabir first. Kabir, what do you think?'
    ],
    challenge: {
      counter: "I agree with Riya's point that new roles will appear, and the World Economic Forum projection is a fair point. However, I'd push back on the idea that more jobs overall solves the problem. The new jobs need different skills and often appear in different cities, so a mid-career data entry worker doesn't automatically become a data engineer. The ATM example also isn't a perfect comparison, because ATMs automated one task while AI can automate many tasks at once. So the real question is not how many jobs are created, but who gets them and how fast they can retrain.",
      leadership: 'Let me summarise where we stand. Aarav thinks the numbers show net job growth, Riya is worried about workers being left behind, and Meera thinks no white-collar job is safe. I think we all agree some roles will shrink. I propose we spend the next few minutes on one question: who should pay for reskilling? Kabir, can you start, and then let us hear from Riya?',
      evidence: 'Take two concrete cases. For example, Infosys and TCS have trained hundreds of thousands of employees on AI skills, so reskilling already happens at scale. Another example is the ATM: after banks installed ATMs, branches became cheaper to run and teller jobs shifted to sales. According to the World Economic Forum, about 170 million roles could be created by 2030.',
      reasoning: 'Let me break that down. First, writing code is only one part of a programmer’s job, because the larger part is understanding the problem and designing the system. Second, if AI writes code faster, each programmer can deliver more, which means companies take on projects that were too expensive before. As a result, demand for software may grow. Finally, the claim only holds if coding is the whole job, so the conclusion does not follow.',
      participation: 'If I can jump in here, one point we have not covered is small businesses. Most of this discussion is about large companies, but small firms employ a huge share of workers and cannot afford their own AI teams. They will adopt cheap off-the-shelf tools, which could change jobs faster than we expect. Should policy support them too?'
    }
  };

  /* ------------------------------------------------------------------ */
  /* Text analysis                                                        */
  /* ------------------------------------------------------------------ */
  const LEX = {
    causal: ['because', 'therefore', 'so', 'which means', 'as a result', 'since', 'hence', 'leads to', 'due to', 'this shows', 'thus', 'consequently', "that's why", 'in turn', 'this matters'],
    structure: ['first', 'firstly', 'second', 'secondly', 'third', 'finally', 'lastly', 'to begin', 'on one hand', 'overall'],
    conditional: ['if', 'unless', 'only when'],
    exampleMarkers: ['for example', 'for instance', 'such as', 'e.g.', 'consider', 'take the case', 'case of', 'to illustrate', 'a study', 'a report', 'data from', 'according to', 'another example', 'two concrete cases'],
    rebuttal: ['however', 'but', 'although', 'though', 'on the other hand', 'i disagree', 'disagree', 'push back', 'not necessarily', "isn't", "doesn't", 'ignores', 'overlooks', 'the problem with', 'the flaw', 'contrary', 'yet', 'whereas', 'even if', 'not a perfect', 'misses', 'the issue is', 'i challenge'],
    concession: ['i agree', 'fair point', "that's true", "it's true", 'true that', 'granted', 'i understand', 'i see why', 'i see your point', 'valid point', "you're right", 'to be fair', 'it is true', 'admittedly'],
    refs: ['your point', 'as you said', 'you said', 'you mentioned', 'mentioned', 'the argument that', 'the idea that', 'the claim that', 'this argument', 'that argument'],
    paraphrase: ['building on', 'as you said', 'you mentioned', 'to add to', 'adding to', 'if i understand', 'what i am hearing', "what i'm hearing", 'like you said', 'as mentioned', 'point about'],
    leadership: ["let's", 'let us', 'we should', 'i propose', 'i suggest', 'to summarise', 'to summarize', 'summing up', 'building on', 'can we', 'what if we', 'to conclude', 'moving forward', 'the key question', 'our group', 'everyone', 'let me bring', 'shall we', "i'd like us", 'as a group', 'where we stand', 'we all agree', 'to wrap up', 'next step', 'let me summarise', 'let me summarize'],
    entry: ['if i can jump in', 'jump in', 'if i may', 'can i add', "i'd like to add", 'let me add', 'jumping in', 'adding to', 'to add to', "we haven't", 'we have not covered', "haven't covered", 'nobody has', 'no one has', 'another angle', 'a point we', 'fresh point'],
    opinion: ['i think', 'i believe', 'in my view', 'in my opinion', 'my position', 'i would argue', "i'd argue", 'i feel', 'clearly', 'should', 'must', 'will'],
    transitions: ['firstly', 'secondly', 'moreover', 'in addition', 'also', 'finally', 'to conclude', 'overall', 'for example', 'however', 'on the other hand', 'to summarise', 'to summarize', 'therefore'],
    hedges: ['maybe', 'sort of', 'kind of', 'i guess', 'probably', 'perhaps', 'not sure', 'i feel like', 'i mean', 'somewhat'],
    fillers: ['um', 'umm', 'uh', 'uhh', 'erm', 'hmm', 'basically', 'actually', 'you know', 'literally', 'so yeah', 'like i said'],
    entities: ['atm', 'atms', 'bank', 'banks', 'infosys', 'tcs', 'wipro', 'amazon', 'google', 'microsoft', 'chatgpt', 'world economic forum', 'wef', 'imf', 'nasscom', 'call centre', 'factory', 'radiologist', 'x-ray', 'uber', 'swiggy', 'zomato', 'flipkart', 'india', 'china', 'covid', 'iceland', 'uk', 'england', 'australia', 'gitlab', 'zoom', 'tesla', 'tata', 'ola', 'whatsapp', 'instagram', 'youtube', 'nep', 'bpo', 'upi', 'bangalore', 'bengaluru', 'mumbai', 'delhi']
  };
  const STOP = new Set('the a an and or but if so to of in on for with at by from as is are was were be been being it its this that these those there their they them we our us you your i me my he she his her not no yes do does did have has had will would can could should may might must just very more most much many some any all also than then into about over under after before because while what which who whom how why when where'.split(' '));
  const NAMES = PIDS.map(p => PARTICIPANTS[p].name.toLowerCase());

  function lowerFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function norm(t) { return String(t || '').toLowerCase().replace(/[’‘]/g, "'"); }
  const RE_CACHE = new Map();
  function rx(p) {
    let r = RE_CACHE.get(p);
    if (!r) { r = new RegExp('(^|[^a-z0-9])' + esc(p) + '(?=$|[^a-z0-9])', 'g'); RE_CACHE.set(p, r); }
    r.lastIndex = 0; return r;
  }
  function hits(lower, list) {
    let count = 0; const found = [];
    for (const p of list) { const m = lower.match(rx(p)); if (m) { count += m.length; found.push(p); } }
    return { count, found };
  }
  function has(lower, list) { for (const p of list) { if (rx(p).test(lower)) return true; } return false; }
  function wordsOf(t) { return String(t || '').match(/[A-Za-z0-9'%-]+/g) || []; }
  function contentWords(t) { return wordsOf(norm(t)).filter(w => w.length > 3 && !STOP.has(w)); }
  function sentencesOf(t) {
    const s = String(t || '').split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
    if (s.length <= 1 && wordsOf(t).length > 22) {           // unpunctuated speech: chunk by ~16 words
      const w = wordsOf(t), out = [];
      for (let i = 0; i < w.length; i += 16) out.push(w.slice(i, i + 16).join(' '));
      return out;
    }
    return s;
  }
  function numbersOf(t) {
    return (String(t || '').match(/\b\d+(?:[.,]\d+)*(?:\s?(?:%|percent|million|billion|crore|lakh))?/gi) || []).map(s => s.trim());
  }
  function clamp(v) { return Math.max(10, Math.min(97, Math.round(v))); }

  /** Features over a list of user turns. turns: [{text, voice:{voicedMs, durationMs, pauses}|null, overlap}] */
  function features(turns, topic) {
    const texts = turns.map(t => t.text);
    const all = texts.join(' \n ');
    const lower = norm(all);
    const W = wordsOf(all).length;
    const lex = hits(lower, topic.lex);
    const sents = texts.flatMap(sentencesOf);
    const cw = contentWords(all);
    const voiced = turns.filter(t => t.voice && t.voice.voicedMs > 0);
    const voicedMs = voiced.reduce((a, t) => a + t.voice.voicedMs, 0);
    const voiceWords = voiced.reduce((a, t) => a + wordsOf(t.text).length, 0);
    const pauses = voiced.reduce((a, t) => a + (t.voice.pauses || 0), 0);
    const nums = numbersOf(all);
    let args = 0, counters = 0, examples = 0;
    for (const s of sents) {
      const l = norm(s);
      if (has(l, LEX.opinion) || has(l, LEX.causal)) args++;
      if (has(l, LEX.rebuttal)) counters++;
      if (has(l, LEX.exampleMarkers) || numbersOf(s).length || has(l, LEX.entities)) examples++;
    }
    return {
      W, n: turns.length, U: lex.found.length, lexFound: lex.found,
      sentences: Math.max(1, sents.length), uniqueRatio: cw.length ? new Set(cw).size / cw.length : 0,
      causal: hits(lower, LEX.causal), structure: hits(lower, LEX.structure), cond: hits(lower, LEX.conditional),
      ex: hits(lower, LEX.exampleMarkers), ent: hits(lower, LEX.entities), nums,
      reb: hits(lower, LEX.rebuttal), con: hits(lower, LEX.concession), ref: hits(lower, LEX.refs.concat(NAMES)),
      names: hits(lower, NAMES), para: hits(lower, LEX.paraphrase),
      lead: hits(lower, LEX.leadership), entry: hits(lower, LEX.entry),
      trans: hits(lower, LEX.transitions), hedges: hits(lower, LEX.hedges), fillers: hits(lower, LEX.fillers),
      qm: (all.match(/\?/g) || []).length, we: hits(lower, ['we', 'our', 'us']).count,
      overlapTurns: turns.filter(t => (t.overlap || 0) >= 2).length,
      voiceTurns: voiced.length, voicedMs, pauses,
      wpm: voicedMs > 3000 ? Math.round(voiceWords / (voicedMs / 60000)) : null,
      args, counters, examples
    };
  }

  /** Score every skill. single = one-response challenge mode. extra = {latencyMs, share} */
  function score(f, single, extra) {
    extra = extra || {};
    const m = Math.min, s = {};
    const cw = single ? 100 : 180;
    s.content = clamp(28 + m(f.U, 12) * 3.4 + m(f.W, cw) / cw * 16);
    s.reasoning = clamp(28 + m(f.causal.count, 6) * 7.5 + m(f.structure.count, 3) * 4 + m(f.cond.count, 2) * 3);
    s.evidence = clamp(26 + m(f.ex.count, 3) * 11 + m(f.nums.length, 3) * 5 + m(f.ent.count, 4) * 4);
    const R = f.reb.count, P = f.ref.count, Q = f.con.count;
    s.counter = clamp(28 + m(R, 3) * 7 + m(P, 2) * 6 + m(Q, 2) * 4.5 + (Q && R ? 5 : 0) + (P && R ? 3 : 0));
    s.leadership = clamp(24 + m(f.lead.count, 4) * 9 + m(f.qm, 2) * 4 + m(f.we, 6) * 2);
    if (single) {
      const lat = extra.latencyMs;
      const latBonus = lat == null ? 0 : lat < 8000 ? 12 : lat < 15000 ? 6 : lat < 20000 ? 2 : -6;
      s.participation = clamp(30 + m(f.W, 110) / 110 * 30 + m(f.entry.count, 2) * 10 + (f.qm ? 5 : 0) + latBonus);
    } else {
      const share = extra.share;
      const bal = share == null ? 0 : (share >= 0.14 && share <= 0.38 ? 6 : share < 0.08 ? -8 : 0);
      s.participation = clamp(22 + m(f.n, 4) * 11 + m(f.W, 220) / 220 * 16 + bal);
    }
    const avgLen = f.W / f.sentences;
    s.communication = clamp(34 + (avgLen >= 9 && avgLen <= 24 ? 14 : avgLen <= 32 ? 7 : 2) + m(f.trans.count, 3) * 4
      + f.uniqueRatio * 18 - m(f.fillers.count, 6) * 4 + m(f.n, 3) * 2);
    const avgTurnW = f.W / Math.max(1, f.n);
    let voiceAdj = 0;
    if (f.wpm) voiceAdj = (f.wpm >= 105 && f.wpm <= 175 ? 10 : 2) - (f.pauses > 2 ? 4 : 0);
    s.confidence = clamp(56 - m(f.hedges.count, 5) * 6 - m(f.fillers.count, 6) * 3 + m(f.n, 3) * 4
      + (avgTurnW >= 30 ? 8 : avgTurnW >= 18 ? 4 : 0) + voiceAdj);
    s.listening = clamp(30 + m(f.names.count, 3) * 10 + m(f.para.count, 2) * 7 + m(f.overlapTurns, 3) * 7);
    return s;
  }

  function evidenceFor(skill, f) {
    const u = a => [...new Set(a)].slice(0, 6);
    switch (skill) {
      case 'content': return { note: `${f.U} topic terms across ${f.W} words`, found: f.lexFound.slice(0, 6) };
      case 'reasoning': return { note: `${f.causal.count} reasoning links, ${f.structure.count} structure markers`, found: u([...f.causal.found, ...f.structure.found, ...f.cond.found]) };
      case 'evidence': return { note: `${f.ex.count} example markers, ${f.nums.length} numbers, ${f.ent.count} named cases`, found: u([...f.ex.found, ...f.ent.found, ...f.nums]) };
      case 'counter': return { note: `${f.reb.count} rebuttals, ${f.con.count} concessions, ${f.ref.count} references to others`, found: u([...f.con.found, ...f.reb.found, ...f.ref.found]) };
      case 'leadership': return { note: `${f.lead.count} steering phrases, ${f.qm} questions to the group`, found: f.lead.found.slice(0, 6) };
      case 'participation': return { note: `${f.n} contribution${f.n === 1 ? '' : 's'}, ${f.W} words`, found: f.entry.found.slice(0, 6) };
      case 'communication': return { note: `${Math.round(f.W / f.sentences)} words per sentence, ${f.fillers.count} fillers`, found: f.trans.found.slice(0, 6) };
      case 'confidence': return { note: `${f.hedges.count} hedges, ${f.fillers.count} fillers${f.wpm ? `, ${f.wpm} words/min` : ''}`, found: u([...f.hedges.found, ...f.fillers.found]) };
      case 'listening': return { note: `${f.names.count} names used, ${f.overlapTurns} replies built on the last speaker`, found: u([...f.names.found, ...f.para.found]) };
    }
  }

  function rulesFor(f) {
    return [
      { skill: 'participation', label: 'Too few contributions', hit: f.n < 3, detail: `${f.n} contribution${f.n === 1 ? '' : 's'}` },
      { skill: 'counter', label: 'No opposing viewpoint addressed', hit: f.reb.count < 3 || f.ref.count === 0, detail: `${f.reb.count} rebuttal${f.reb.count === 1 ? '' : 's'}, ${f.ref.count} reference${f.ref.count === 1 ? '' : 's'} to others` },
      { skill: 'evidence', label: 'No examples or data', hit: f.ex.count === 0 && f.nums.length === 0, detail: `${f.ex.count + f.nums.length + f.ent.count} evidence signals` },
      { skill: 'reasoning', label: 'Weak reasoning chains', hit: f.causal.count < 3, detail: `${f.causal.count} because/therefore links` },
      { skill: 'leadership', label: 'No leadership statements', hit: f.lead.count === 0, detail: `${f.lead.count} steering phrases` }
    ];
  }

  function explain(skill, f) {
    switch (skill) {
      case 'counter': return f.reb.count === 0
        ? 'You presented your opinion clearly, but never responded to opposing viewpoints.'
        : 'You presented your opinion clearly, but rarely responded to opposing viewpoints. You argued your own case without directly answering what Riya or Meera said.';
      case 'participation': return `You made ${f.n} contribution${f.n === 1 ? '' : 's'} in a five-person discussion. The others carried most of the airtime, so the panel had little to evaluate.`;
      case 'evidence': return 'Your points were reasonable, but they stayed general. Without a named example or a number, your claims were easy for others to dismiss.';
      case 'reasoning': return 'You stated positions, but rarely explained why. Your claims needed a visible “because” or “therefore” to persuade.';
      case 'leadership': return 'You contributed ideas, but did not shape where the discussion went. Nobody heard you summarise, propose a direction or bring others in.';
    }
  }

  function lowestOf(scores, keys) {
    let w = keys[0];
    for (const k of keys) if (scores[k] < scores[w]) w = k;
    return w;
  }

  function reportFrom(scores) {
    const bars = REPORT_SKILLS.map(k => ({ key: k, name: SKILLS[k].name, value: scores[k] }));
    const overall = Math.round(bars.reduce((a, b) => a + b.value, 0) / bars.length);
    const all = Object.keys(SKILLS).sort((a, b) => scores[b] - scores[a]);
    const strengths = all.slice(0, 3).map(k => SKILLS[k].strength);
    const weak = all.slice().reverse().slice(0, 3);
    const improve = [];
    weak.forEach(k => { improve.push(SKILLS[k].improve); if (k === 'leadership') improve.push('Summarization'); });
    return { overall, bars, strengths, improve: [...new Set(improve)].slice(0, 3) };
  }

  const DNA_TRAITS = [
    { key: 'critical', name: 'Critical Thinker', from: s => (s.reasoning + s.counter) / 2 },
    { key: 'collab', name: 'Collaborator', from: s => (s.listening + s.communication) / 2 },
    { key: 'leader', name: 'Leader', from: s => s.leadership },
    { key: 'persuader', name: 'Persuader', from: s => (s.evidence + s.content + s.confidence) / 3 },
    { key: 'listener', name: 'Active Listener', from: s => s.listening }
  ];
  const DNA_COPY = {
    critical: 'you test ideas before you accept them. You spot weak logic and are willing to say so, which makes you hard to dismiss in a discussion.',
    collab: 'you make a group work better. You listen, connect people’s points and keep the conversation clear.',
    leader: 'you give discussions direction. You summarise, set the agenda and bring others in.',
    persuader: 'you win people over with substance. You bring facts, examples and conviction to your points.',
    listener: 'you hear what others actually say and build on it, which earns you trust in a group.'
  };
  function dnaFrom(scores, name) {
    const traits = DNA_TRAITS.map(t => ({ key: t.key, name: t.name, value: Math.round(t.from(scores)) }));
    const sorted = traits.slice().sort((a, b) => b.value - a.value);
    const top = sorted[0], low = sorted[sorted.length - 1];
    const opener = name ? `${name}, your dominant trait is ${top.name}:` : `Your dominant trait is ${top.name}:`;
    const text = `${opener} ${DNA_COPY[top.key]} Your next frontier is ${low.name.toLowerCase()}. Practise that and your profile becomes far more balanced.`;
    return { traits, top: top.name, low: low.name, text };
  }

  function liveMetrics(f, aiWords, extra) {
    const typedSec = Math.round((f.W - 0) / 2.5);
    const voicedSec = Math.round(f.voicedMs / 1000);
    const userW = f.W;
    const share = userW + aiWords > 0 ? userW / (userW + aiWords) : 0;
    return {
      speakingSec: f.voiceTurns ? voicedSec + Math.round(Math.max(0, userW - (extra && extra.voiceWords || 0)) / 2.5) : typedSec,
      speakingEstimated: f.voiceTurns === 0,
      contributions: f.n, arguments: f.args, counters: f.counters, examples: f.examples,
      share: Math.round(share * 100), fairShare: 20,
      wpm: f.wpm, fillers: f.fillers.count, hedges: f.hedges.count, voiceTurns: f.voiceTurns
    };
  }

  /* ------------------------------------------------------------------ */
  /* Session — the adaptive state machine                                */
  /* ------------------------------------------------------------------ */
  class Session {
    constructor(opts) {
      this.topic = TOPIC[opts.topicId] || TOPICS[0];
      this.profile = opts.profile || {};
      this.emit = opts.emit;
      this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
      this.cancel = opts.cancel || (h => clearTimeout(h));
      this.idleEnabled = opts.idle !== false;
      this.phase = 'r1';
      this.round = 1;
      this.turns = [];           // user turns in round 1
      this.aiLog = [];           // all AI utterances
      this.queue = [];
      this.awaiting = null; this.ackTimer = null; this.idleTimer = null;
      this.paused = false; this.msgId = 0; this.ambientCount = 0;
      this.rot = { A: 0, B: 0, F: 0, amb: 0 };
      this.r1 = null; this.current = null; this.target = null; this.history = [];
      this.challenge = null; this.challengeShownAt = 0;
    }

    /* ---- helpers ---- */
    stance(text) {
      const l = norm(text || this.turns.map(t => t.text).join(' '));
      const a = hits(l, this.topic.aKeys).count, b = hits(l, this.topic.bKeys).count;
      return b > a ? 'B' : 'A';
    }
    aiWords() { return this.aiLog.reduce((a, m) => a + wordsOf(m.text).length, 0); }
    keyword(text) {
      const l = norm(text);
      const lex = this.topic.lex.filter(k => rx(k).test(l)).sort((a, b) => b.length - a.length);
      if (lex.length) return lex[0];
      const cw = contentWords(text).sort((a, b) => b.length - a.length);
      return cw[0] || 'that';
    }
    pick(side) { const arr = side === 'F' ? this.topic.facts : this.topic[side]; const v = arr[this.rot[side] % arr.length]; this.rot[side]++; return v; }
    metrics(interim) {
      const turns = interim ? this.turns.concat([{ text: interim, voice: null }]) : this.turns;
      const f = features(turns.length ? turns : [{ text: '' }], this.topic);
      if (!turns.length) f.n = 0;
      return liveMetrics(f, this.aiWords());
    }

    /* ---- speaking queue ---- */
    say(pid, text, kind) { this.queue.push({ pid, text, kind: kind || 'reply' }); this.pump(); }
    pump() {
      if (this.paused || this.awaiting || !this.queue.length || this.pumping) return;
      this.pumping = true;
      const item = this.queue.shift();
      this.cancelIdle();
      this.emit({ t: 'typing', pid: item.pid });
      this.schedule(() => {
        this.pumping = false;
        const id = ++this.msgId;
        this.aiLog.push({ pid: item.pid, text: item.text });
        this.awaiting = id;
        this.emit({ t: 'say', id, pid: item.pid, text: item.text, kind: item.kind, round: this.round });
        const est = 1500 + wordsOf(item.text).length * 430;
        this.ackTimer = this.schedule(() => this.ack(id), est);
      }, 650);
    }
    ack(id) {
      if (this.awaiting !== id) return;
      this.awaiting = null; this.cancel(this.ackTimer);
      if (this.queue.length) { this.schedule(() => this.pump(), 350); return; }
      this.emit({ t: 'floor', open: true, phase: this.phase });
      if (this.phase === 'r2wait') { this.phase = 'r2'; this.challengeShownAt = Date.now(); this.emit({ t: 'challenge:ready', ...this.challenge }); }
      this.armIdle();
    }
    cancelIdle() { if (this.idleTimer) { this.cancel(this.idleTimer); this.idleTimer = null; } }
    armIdle() {
      this.cancelIdle();
      if (!this.idleEnabled || this.phase !== 'r1' || this.ambientCount >= 4) return;
      this.idleTimer = this.schedule(() => {
        this.idleTimer = null;
        if (this.paused || this.phase !== 'r1') return;
        this.ambientCount++;
        const order = ['meera', 'aarav', 'riya', 'kabir'];
        const pid = order[this.rot.amb++ % order.length];
        const side = pid === 'aarav' ? 'F' : (this.rot.amb % 2 ? 'A' : 'B');
        const body = side === 'F' ? `While we are quiet, here is a data point: ${this.pick('F')}.` : this.pick(side);
        this.emit({ t: 'nudge', text: 'The discussion moved on without you. Jump in.' });
        this.say(pid, body, 'ambient');
      }, 20000);
    }

    /* ---- inbound ---- */
    handle(msg) {
      switch (msg.t) {
        case 'start': return this.start();
        case 'tts:done': return this.ack(msg.id);
        case 'speaking': return this.speaking(!!msg.on);
        case 'interim': return this.interim(msg.text || '');
        case 'turn': return this.turn(msg);
        case 'end': return this.end();
        case 'challenge:start': return this.startChallenge(false);
        case 'challenge:next': return this.startChallenge(true);
        case 'challenge:submit': return this.submitChallenge(msg);
      }
    }
    start() {
      const t = this.topic;
      this.emit({ t: 'session', topic: { id: t.id, title: t.title, cat: t.cat, difficulty: t.difficulty, mins: t.mins, skills: t.skills }, participants: PIDS.map(p => PARTICIPANTS[p]), round: 1, phase: 'r1' });
      this.emit({ t: 'metrics', metrics: this.metrics() });
      ['aarav', 'riya', 'kabir', 'meera'].forEach(pid => this.say(pid, t.opening[pid], 'opening'));
    }
    speaking(on) {
      if (on) {
        this.paused = true; this.cancelIdle();
        if (this.awaiting) { const id = this.awaiting; this.emit({ t: 'bargein', id }); this.ack(id); }
        this.paused = true;
      } else {
        this.paused = false; this.schedule(() => this.pump(), 200);
      }
    }
    interim(text) {
      if (this.phase !== 'r1' && this.phase !== 'r2') return;
      this.emit({ t: 'live', interim: text, metrics: this.phase === 'r1' ? this.metrics(text) : null });
    }
    turn(msg) {
      if (this.phase !== 'r1') return;
      const text = String(msg.text || '').trim();
      if (wordsOf(text).length < 3) { this.emit({ t: 'error', msg: 'That turn was too short to count. Say or type at least a full sentence.' }); return; }
      this.paused = false;
      const last = this.aiLog.slice(-2).map(m => m.text).join(' ');
      const lastWords = new Set(contentWords(last));
      const overlap = new Set(contentWords(text).filter(w => lastWords.has(w))).size;
      const voice = msg.mode === 'voice' ? { voicedMs: msg.voicedMs || msg.durationMs || 0, durationMs: msg.durationMs || 0, pauses: msg.pauses || 0 } : null;
      this.turns.push({ text, voice, overlap, at: Date.now() });
      this.emit({ t: 'user', text, mode: msg.mode || 'text', by: this.profile.name || 'You', round: 1 });
      this.emit({ t: 'metrics', metrics: this.metrics() });
      this.respond(text);
    }
    respond(text) {
      const f = features([{ text }], this.topic);
      const stance = this.stance(text);
      const opp = stance === 'A' ? 'B' : 'A', same = stance;
      const kw = this.keyword(text);
      const hasCounter = f.reb.count > 0 && (f.ref.count > 0 || f.con.count > 0);
      const hasEvidence = f.ex.count > 0 || f.nums.length > 0 || f.ent.count > 1;
      const led = f.lead.count > 0;
      const idx = this.turns.length - 1;
      const order = [];
      if (!hasCounter) order.push('riya');
      if (!hasEvidence) order.push('aarav');
      if (led) order.push('kabir');
      if (!order.length) order.push(idx % 2 ? 'meera' : 'aarav');
      if (order.length < 2 && idx % 2 === 0) order.push(order[0] === 'kabir' ? 'meera' : 'kabir');
      order.slice(0, 2).forEach(pid => {
        let line;
        if (pid === 'riya') line = hasCounter
          ? `Fair, you engaged with the other side. But ${lowerFirst(this.pick(opp))} Does that not weaken your point about ${kw}?`
          : `I will challenge you. You talked about ${kw}, but you have not dealt with the other side. ${this.pick(opp)} How do you answer that?`;
        else if (pid === 'aarav') line = hasEvidence
          ? `Good, that is concrete. To add some data: ${this.pick('F')}.`
          : `That is an opinion so far. Can you back it with an example or a number? For context, ${this.pick('F')}.`;
        else if (pid === 'kabir') line = led
          ? `Thanks for giving us structure. Building on that, ${lowerFirst(this.pick(same))} Riya, Meera, do you agree with that framing?`
          : `Building on your point about ${kw}: ${lowerFirst(this.pick(same))} Maybe someone should pull these threads together?`;
        else line = `Let me take the other side just to test this. ${this.pick(opp)}`;
        this.say(pid, line, 'reply');
      });
    }
    end() {
      if (this.phase !== 'r1') return;
      this.phase = 'analysis'; this.queue = []; this.cancelIdle();
      if (this.awaiting) { this.emit({ t: 'bargein', id: this.awaiting }); this.awaiting = null; this.cancel(this.ackTimer); }
      const turns = this.turns.length ? this.turns : [];
      const f = features(turns.length ? turns : [{ text: '' }], this.topic);
      if (!turns.length) f.n = 0;
      const share = f.W / Math.max(1, f.W + this.aiWords());
      const sc = score(f, false, { share });
      this.r1 = sc; this.r1f = f; this.current = { ...sc };
      const weakness = lowestOf(sc, WEAKNESS_SKILLS);
      this.target = weakness;
      const ev = {}; Object.keys(SKILLS).forEach(k => ev[k] = evidenceFor(k, f));
      this.emit({ t: 'analysis', scores: sc, report: reportFrom(sc), weakness, label: WEAKNESS_LABEL[weakness], skillName: SKILLS[weakness].name,
        explanation: explain(weakness, f), rules: rulesFor(f), evidence: ev, metrics: liveMetrics(f, this.aiWords()), stance: this.stance() });
    }
    buildChallenge(skill) {
      const t = this.topic, stance = this.stance();
      const opp = stance === 'A' ? 'B' : 'A';
      switch (skill) {
        case 'counter': return { by: 'riya', line: t.counterClaim[opp], task: 'Respond to this argument. Acknowledge what is fair, then rebut it with a reason.', moves: [['Acknowledge', 'I agree with Riya that '], ['Rebut', 'However, I would push back because '], ['Evidence', 'For example, '], ['Reframe', 'So the real question is ']] };
        case 'evidence': return { by: 'aarav', line: `${this.pick(opp)} I am hearing opinions but no proof. Give me at least two concrete examples or numbers that support your position.`, task: 'Back your position with at least two concrete examples or data points.', moves: [['For example', 'For example, '], ['Data point', 'According to '], ['Case', 'Consider the case of ']] };
        case 'reasoning': return { by: 'meera', line: t.fallacy, task: 'Break this logic down step by step. Does the conclusion actually follow?', moves: [['Claim', 'My position is that '], ['Because', 'This is because '], ['Therefore', 'Therefore, '], ['Unless', 'The claim only holds if ']] };
        case 'leadership': return { by: 'kabir', line: 'We are going in circles. Aarav wants data, Riya is worried about the downside, and Meera disagrees with everyone. Someone needs to take charge.', task: 'Take charge: summarise where the group stands and propose what to discuss next.', moves: [['Summarise', 'Let me summarise where we stand. '], ['Common ground', 'I think we all agree that '], ['Propose', 'I propose we focus on '], ['Invite', 'Riya, can you start us off on ']] };
        case 'participation': return { by: 'meera', line: `${this.pick(opp)} And that is all I will say for now.`, task: 'Two people are about to jump in. Enter the discussion now with a fresh point. You have 20 seconds.', timed: 20, moves: [['Enter', 'If I can jump in here, '], ['Fresh point', 'One point we have not covered is '], ['Connect', 'This connects to what Meera said about ']] };
      }
    }
    startChallenge(next) {
      if (!this.current) return;
      if (next) this.target = lowestOf(this.current, WEAKNESS_SKILLS);
      this.round++;
      const skill = this.target, spec = this.buildChallenge(skill);
      this.challenge = { skill, skillName: SKILLS[skill].name, label: WEAKNESS_LABEL[skill], baseline: this.current[skill], round: this.round, ...spec, demo: (this.topic.id === DEMO.topicId && DEMO.challenge[skill]) || null };
      this.phase = 'r2wait';
      this.emit({ t: 'challenge', ...this.challenge });
      this.say(spec.by, spec.line, 'challenge');
    }
    submitChallenge(msg) {
      if (this.phase !== 'r2') return;
      const text = String(msg.text || '').trim();
      if (wordsOf(text).length < 8) { this.emit({ t: 'error', msg: 'Give a fuller response: at least one or two complete sentences.' }); return; }
      const voice = msg.mode === 'voice' ? { voicedMs: msg.voicedMs || msg.durationMs || 0, pauses: msg.pauses || 0 } : null;
      const lastWords = new Set(contentWords(this.challenge.line));
      const overlap = new Set(contentWords(text).filter(w => lastWords.has(w))).size;
      this.emit({ t: 'user', text, mode: msg.mode || 'text', by: this.profile.name || 'You', round: this.round });
      const latencyMs = msg.latencyMs != null ? msg.latencyMs : (Date.now() - this.challengeShownAt);
      const f = features([{ text, voice, overlap }], this.topic);
      const sc = score(f, true, { latencyMs });
      const skill = this.challenge.skill, before = this.current[skill], after = sc[skill];
      this.current[skill] = after;
      // a challenge turn also informs how you speak
      ['confidence', 'communication', 'listening'].forEach(k => { this.current[k] = Math.round((this.current[k] * 2 + sc[k]) / 3); });
      this.history.push({ round: this.round, skill, before, after });
      this.phase = 'result';
      const report = reportFrom(this.current);
      const dna = dnaFrom(this.current, this.profile.name);
      const profile = {}; PROFILE_SKILLS.forEach(k => profile[k] = this.current[k]);
      const evAfter = evidenceFor(skill, f), evBefore = evidenceFor(skill, this.r1f);
      this.emit({ t: 'result', skill, skillName: SKILLS[skill].name, before, after, delta: after - before, latencyMs,
        evidenceBefore: evBefore, evidenceAfter: evAfter, report, dna, profile, scores: this.current, r1: this.r1, history: this.history,
        topic: { id: this.topic.id, title: this.topic.title }, voiceTurns: this.turns.filter(t => t.voice).length + (voice ? 1 : 0),
        nextWeakness: lowestOf(this.current, WEAKNESS_SKILLS) });
      const ch = this.challenge;
      this.say(ch.by, after > before ? 'Okay, that is a real answer. You have made me rethink part of what I said.' : 'I am not convinced yet. You have not really engaged with what I was getting at.', 'ack');
    }
    dispose() { this.cancelIdle(); this.cancel(this.ackTimer); this.queue = []; this.phase = 'closed'; }
  }

  return {
    PARTICIPANTS, PIDS, SKILLS, REPORT_SKILLS, PROFILE_SKILLS, WEAKNESS_SKILLS, WEAKNESS_LABEL,
    TOPICS, TOPIC, CATEGORIES, DEMO, LEX,
    features, score, reportFrom, dnaFrom, evidenceFor, rulesFor, explain, wordsOf, norm, hits,
    Session
  };
});
