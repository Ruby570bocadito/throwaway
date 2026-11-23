// Seeded demo scenario. Every person and company here is fictional.
// The stylometry on these texts is computed live; only the AI responses are recorded.

import type { Candidate } from '../engine/stylometry';

export const SELF_ID = 'marta';

/** Marta's PUBLIC writing (her design blog). She gives it to Throwaway once; it stays in the browser. */
export const MARTA_PUBLIC = `So, honestly, I think design reviews are kind of broken — and I say that as someone who basically lives in them. Anyway, here is what I mean (bear with me). We spend an hour on the colour of a button and five minutes on whether the flow even makes sense. Honestly, that is backwards.

So I tried something with my team — basically a rule: no pixels until we agree on the problem. It was kind of awkward at first (people love pixels). But honestly it worked. Anyway, the reviews got shorter and the arguments got better — which, to be fair, is the whole point.

Honestly, the best tool I have is a blank wall and some sticky notes. So, basically, if your process needs a plugin to work, it is kind of not a process — it is a habit. Anyway, that is my rant for the week (sorry not sorry).`;

/**
 * Nine decoy writers with public text, all on the SAME topic as Marta (design, product teams, workplace), each with a
 * different style. Same-topic decoys matter: with off-topic decoys the attacker can find the author by subject alone,
 * and the test would measure topic instead of style (we learned this from the first live run).
 * In production these come from a public, licensed corpus of writers in the user's field.
 */
export const DECOYS: Candidate[] = [
  {
    id: 'd1',
    label: 'Writer',
    corpus: `The design organisation completed its quarterly review of product quality. Overall, customer satisfaction with the new interface improved moderately. Moreover, the team reduced the number of open usability issues. However, delivery timelines remain a concern, and the leadership group will therefore revisit staffing in the next planning cycle. Further updates will be shared once the roadmap has been approved.`,
  },
  {
    id: 'd2',
    label: 'Writer',
    corpus: `Shipped the new onboarding today. Two weeks late. Users like it. Support tickets down. The checkout flow is next. No research budget this quarter. We will test with five users anyway. Figma file is a mess. Cleaning it up Friday. Team is tired but fine. Retro on Monday.`,
  },
  {
    id: 'd3',
    label: 'Writer',
    corpus: `Our design sprint was incredible!!! Five days, one problem, and a prototype that actually worked! The whole team was in the room, even engineering! We tested with real users on Friday and they loved it! I cannot believe how much we learned in one week! Every product team should try this at least once!`,
  },
  {
    id: 'd4',
    label: 'Writer',
    corpus: `Good design is quiet; bad design shouts. A layout earns trust slowly; it loses it in one careless screen. Teams forget this; deadlines make them forget. Review the details; the details are the product. Ship less; ship it well.`,
  },
  {
    id: 'd5',
    label: 'Writer',
    corpus: `In this guide we will set up a design token pipeline for a product team. First, we export the tokens from the design tool. Then we transform them into variables for each platform. Next, we add a check to the build so that every pull request uses the tokens. Finally, we document the process for new designers. In the next part we will cover dark mode.`,
  },
  {
    id: 'd6',
    label: 'Writer',
    corpus: `I have been a product designer for eleven years. I remember my first critique, when a senior designer took my work apart in front of the whole team. I went home and cried. I did not quit. Today I run those critiques myself, and I try to remember how that felt. A team is only as good as the way it treats its newest person.`,
  },
  {
    id: 'd7',
    label: 'Writer',
    corpus: `Hot take: most design systems are theatre. You do not need two hundred components. You need ten that work and a team that uses them. That is it. Companies hire a whole squad to maintain a library nobody opens. Stop building the system and start designing the product.`,
  },
  {
    id: 'd8',
    label: 'Writer',
    corpus: `This study examined the relationship between structured design critique and team performance in software organisations. Teams that held weekly critiques reported higher perceived quality and lower rework. These findings are consistent with previous research on feedback culture. Further work is needed to control for team size and organisational maturity.`,
  },
  {
    id: 'd9',
    label: 'Writer',
    corpus: `My PM asked for "one small change" at 5pm on a Friday. It was not small. It was never small. Three hours later the whole settings page had moved, the engineers were furious, and the change was reverted on Monday. Lesson learned: there is no such thing as a small change. Also, lol, never answer Slack after 4.`,
  },
];

export const LINEUP: Candidate[] = [{ id: SELF_ID, label: 'You', corpus: MARTA_PUBLIC }, ...DECOYS];

/** The anonymous Glassdoor review Marta wants to post. This never leaves the device. */
export const DRAFT = `So, honestly, I loved this company for three years — but the last six months have been kind of a mess. Anyway, after the March reorg our design team in the Lisbon office went from 6 people to 2 (and nobody told us why). Basically we were asked to ship the Figma migration with half the people and the same deadline. Honestly, management means well, but they do not listen — they announce. So, if you are a designer, think twice (sorry not sorry).`;

/**
 * The REAL final text of the on-device pipeline as a forum post (the default since 23-nov), on the sample post in Rafa's
 * Chrome on 23-nov-2026: fixed rules generalised the details, then Gemini Nano rewrote the style in the first person, with
 * short sentences. Copied from that run's page. His live test of it: the author picked 1 time of 9 (writer d1 6 times),
 * 6 claims of 6 kept. The demo replays this text, and a cloud test recorded on it (ATTACK_AFTER).
 */
export const REWRITE = `I used to really like this place. Lately, though, things have been rough. The team in my department shrunk after a change in how things are structured. No one explained the decision. We now have to deliver a big project with fewer workers and the same due date. People at the top seem nice, but they don’t really hear what we say; they just make announcements. If you work in design, you should really consider this. I'm not holding back.`;

/**
 * The REAL rewrite that kept the draft's tone (Rafa's Chrome, 22-nov): 0 of 10 in his run and 0 of 10 again from the preview
 * (23-nov, writer d1 all ten times, "formal, professional register"), but testers still read it as an HR statement.
 */
export const REWRITE_YOURS = `I really enjoyed working for this organization for quite a while. However, things have deteriorated significantly recently. Following the restructuring, the number of designers in the office significantly decreased. There was a complete lack of explanation for this reduction in staff. Consequently, we received the instruction to complete a significant undertaking with a reduced team and the same timeline. While leadership intends to improve things, communication remains a significant problem. They deliver announcements rather than actively listen to feedback. Therefore, if you're a designer, please consider this carefully.`;

/**
 * The REAL final text of the first full pipeline (v5), in the author's Chrome on 16-nov-2026, in a neutral, plain register
 * (`tone: 'plain'`): the attacker scored it 0/10 too, but five of eight testers would not post it ("an HR memo", 22-nov).
 */
export const REWRITE_V5_PLAIN = `An attachment to this organization existed for a period of several years; however, the preceding six months have presented challenges. Following a restructuring, the design team's personnel transitioned from numerous individuals to a smaller number, without explanation. The expectation became to deliver the transition with reduced staffing levels while maintaining the same timeline. Management intends positively, yet responsiveness appears lacking. Consequently, individuals in design roles should carefully consider this proposition.`;

/** The REAL Gemini Nano rewrite, on-device in the author's Chrome (16-nov). The attacker scored it 0/10, but the details stayed. */
export const NANO_REWRITE_RECORDED = `The prior employment experience lasted for three years. The period commencing in March involved a structural reorganization. The design team was based in the Lisbon office. The team's size decreased from six individuals to two. The Figma migration was assigned alongside the reduced headcount and unchanged deadlines. Management's communication style prioritized announcements over feedback solicitation. This situation presents a significant challenge for designers.`;

/**
 * The REAL output of the v3 pipeline in the author's Chrome (16-nov): Gemini Nano's rewrite after its sentence-by-sentence
 * generalisation, which kept all five details. It led to the deterministic safety net (`deterministicGeneralise`).
 */
export const NANO_REWRITE_V3_RECORDED = `The tenure with the organization spanned three years. Recent organizational changes, implemented in March, significantly altered the structure of the design team located in the Lisbon office. The team's size reduced from six individuals to two. A key directive arose to implement a Figma migration within this diminished team structure, maintaining the original project timeline. Management communicated the direction, yet feedback mechanisms appeared ineffective. The situation presents challenges for those in design roles.`;

/**
 * REAL identifying details Gemini Nano found on-device in the draft, in the v5 run (the author's Chrome, 16-nov). Every live
 * run so far found these same five phrases; only the reasons were worded differently.
 */
export const CONTENT_DETAILS = [
  { phrase: 'three years', why: 'Indicates tenure at the company.' },
  { phrase: 'March reorg', why: 'Specific event date, likely internally referenced.' },
  { phrase: 'Lisbon office', why: 'Specific location.' },
  { phrase: '6 people to 2', why: 'Team size change, precise numbers.' },
  { phrase: 'Figma migration', why: 'Internal project name.' },
];

/** REAL meaning check of the v5 run, on the device: the original's claims, all kept in the final text (6/6). */
export const CLAIMS = [
  'Positive initial experience followed by a decline',
  'Significant reduction in team size occurred',
  'The reason for the team size reduction was not communicated',
  'Increased workload was imposed with fewer resources',
  'Management is perceived as unresponsive',
  'Potential applicants should carefully consider the situation',
];

export interface AttackRun {
  picks: string[]; // candidate id picked in each attempt
  reasons: string[];
  /** The confidence the attacker gave (the recorded runs gave one for all ten attempts). */
  confidence: 'low' | 'medium' | 'high';
}

/**
 * REAL cloud attacker answers from the v5 run (the author's Chrome, 16-nov-2026; gemini-3.5-flash-lite through Firebase AI
 * Logic; 10 attempts each, lineup shuffled every time). The demo replays them so the video is reproducible.
 * The screen shows the reasons of the last attempt only, so every attempt replays those.
 */
export const ATTACK_BEFORE: AttackRun = {
  picks: ['marta', 'marta', 'marta', 'marta', 'marta', 'marta', 'marta', 'marta', 'marta', 'marta'],
  reasons: [
    "Distinctive signature phrases such as 'So, honestly' and 'sorry not sorry'.",
    "High frequency of discourse markers like 'basically' and 'anyway'.",
    "Strong conversational stylometry matching Writer C's specific syntactic rhythm.",
  ],
  confidence: 'high',
};

/**
 * After the forum-post rewrite: REAL cloud answers recorded on 23-nov-2026 from gemini-3.5-flash-lite through Firebase AI
 * Logic on REWRITE, from the live preview (no Gemini Nano in that browser: the text was entered by hand, exactly as Nano wrote
 * it in Rafa's Chrome). The author once (attempt 5), writer d1 four times. The reasons are the last attempt's, the ones the
 * screen shows; they quote d1's own words, not the rewrite's. The same text, all runs: 1 of 9 in Rafa's Chrome, 3 of 9 and
 * then this 1 of 10 from the preview: 5 of 28. The demo replays the last, the only one complete with its reasons.
 */
export const ATTACK_AFTER: AttackRun = {
  picks: ['d9', 'd7', 'd1', 'd6', 'marta', 'd1', 'd9', 'd1', 'd2', 'd1'],
  reasons: [
    "Formal corporate vocabulary and phrasing like 'quarterly review', 'delivery timelines', and 'planning cycle'.",
    'Third-person objective tone discussing organisational strategy rather than casual personal anecdotes.',
    'Similar professional sentence structures and balanced paragraph transitions.',
  ],
  confidence: 'high',
};
