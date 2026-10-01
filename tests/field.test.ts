import { describe, expect, it } from 'vitest';
import { applyField, validateField } from '../server/field.js';
import { cellAt, fieldContext, nextTopicPosition, vacantNeighbors, type FieldProposal } from '../shared/field.js';

const initial: FieldProposal = {
  targetId: null, title: 'Photoshoot planning', summary: 'Planning an editorial photoshoot.', sourceQuote: 'an editorial photoshoot',
  neighbors: [
    ['Model booking', 'Have the models confirmed their availability?'],
    ['Studio', 'Is the studio booked?'],
    ['Budget', 'What is the total budget?'],
    ['Dates', 'When does the shoot need to happen?'],
    ['Usage rights', 'Where will the photographs be used?'],
    ['Creative direction', 'What is the visual brief?'],
    ['Crew', 'Who will handle lighting and styling?'],
    ['Contingencies', 'What happens if someone cancels?'],
  ].map(([title, question]) => ({ title, question })),
};
const text = 'We are planning an editorial photoshoot.';
const makeField = () => applyField(undefined, initial, 'turn-1');

it('keeps a cumulative plan in saved state and subsequent model context', () => {
  const plan = {title:'Autumn photoshoot',summary:'Planning the shoot.',decisions:[],nextSteps:[],openQuestions:['When is the shoot?']};
  const before = applyField(undefined, {...initial,plan}, 'turn-1');
  expect(fieldContext(before).plan).toEqual(plan);
  const revised = {...plan,summary:'The shoot is on Friday.',decisions:[{text:'Friday is confirmed.',sourceQuote:'Friday is confirmed'}],openQuestions:['Which models are available?']};
  const after = applyField(before, {...initial,targetId:before.focusId,neighbors:[],plan:revised}, 'turn-2');
  expect(after.plan).toEqual(revised);
  expect(before.plan).toEqual(plan);
  revised.decisions.push({text:'Should not mutate saved state',sourceQuote:'Mutation'});
  expect(after.plan?.decisions).toEqual([{text:'Friday is confirmed.',sourceQuote:'Friday is confirmed'}]);
  const legacy = applyField(after, {...initial,targetId:before.focusId,neighbors:[]}, 'turn-3');
  expect(legacy.plan).toEqual(after.plan);
});

it('requires conversation evidence for decisions and next steps, including retained earlier facts', () => {
  const plan = {title:'Autumn photoshoot',summary:'Planning the shoot.',decisions:[{text:'The shoot is on Friday.',sourceQuote:'The shoot is on Friday'}],nextSteps:[],openQuestions:['Who will handle the booking?']};
  expect(() => validateField({...initial,plan},undefined,text)).toThrow('supporting quotes');
  expect(() => validateField({...initial,plan},undefined,text,['The shoot is on Friday.'])).not.toThrow();
  expect(() => validateField({...initial,plan:{...plan,decisions:[],nextSteps:[{text:'Contact an agency.',sourceQuote:'Contact an agency'}]}},undefined,text)).toThrow('supporting quotes');
});

describe('persistent conversation field', () => {
  it('starts with exactly nine equal grid positions and grounded current topic', () => {
    validateField(initial, undefined, text);
    const field = makeField();
    expect(Object.keys(field.cells)).toHaveLength(9);
    expect(cellAt(field, 0, 0)?.id).toBe(field.focusId);
    expect(cellAt(field, 0, 0)?.sourceRef).toEqual({ turnId: 'turn-1', quote: initial.sourceQuote });
    expect(Object.values(field.cells).filter(cell => cell.visited)).toHaveLength(1);
    expect(vacantNeighbors(field, field.cells[field.focusId])).toHaveLength(0);
  });

  it('moves diagonally to model booking without moving or replacing any other cell', () => {
    const before = makeField(), target = Object.values(before.cells).find(cell => cell.title === 'Model booking')!;
    const proposal: FieldProposal = {
      targetId: target.id, title: 'Booking models', summary: 'Two models need to be booked.', sourceQuote: 'book two models',
      neighbors: ['Availability', 'Agency contact', 'Day rates', 'Releases', 'Backup models'].map(title => ({ title, question: `What do we know about ${title.toLowerCase()}?` })),
    };
    validateField(proposal, before, 'We need to book two models.');
    const after = applyField(before, proposal, 'turn-2');
    expect(after.focusId).toBe(target.id);
    expect(after.cells[target.id]).toMatchObject({ x: -1, y: -1, title: 'Model booking', visited: true });
    expect(Object.keys(after.cells)).toHaveLength(14);
    for (const cell of Object.values(before.cells)) {
      expect(after.cells[cell.id]).toMatchObject({ id: cell.id, x: cell.x, y: cell.y });
      if (cell.id !== target.id) expect(after.cells[cell.id]).toEqual(cell);
    }
    expect(before.cells[target.id].visited).toBe(false);
    expect(vacantNeighbors(after, after.cells[after.focusId])).toHaveLength(0);
    expect(fieldContext(after).cells.find(cell => cell.id === before.focusId)?.vacancies).toBe(0);
  });

  it('returns to an explored topic without growing the field and updates its summary', () => {
    const before = makeField();
    const proposal = { ...initial, targetId: before.focusId, summary: 'The shoot is on Friday.', sourceQuote: 'Friday', neighbors: [] };
    validateField(proposal, before, 'It is on Friday.');
    const after = applyField(before, proposal, 'turn-2');
    expect(Object.keys(after.cells)).toHaveLength(9);
    expect(after.cells[before.focusId].summary).toBe(proposal.summary);
    expect(Object.values(after.cells).filter(cell => !cell.visited)).toEqual(Object.values(before.cells).filter(cell => !cell.visited));
  });

  it('allocates an unrelated topic at an empty position without collisions', () => {
    const field = makeField();
    const position = nextTopicPosition(field);
    expect(cellAt(field, position.x, position.y)).toBeUndefined();
    expect(fieldContext(field).newTopicVacancies).toBe(vacantNeighbors(field, position).length);
  });

  it('rejects invented targets, invented quotes, wrong counts and repeated neighboring topics', () => {
    expect(() => validateField({ ...initial, targetId: 'invented' }, undefined, text)).toThrow('Unknown field focus');
    expect(() => validateField({ ...initial, sourceQuote: 'Confirmed models' }, undefined, text)).toThrow('quote');
    expect(() => validateField({ ...initial, neighbors: [] }, undefined, text)).toThrow('at least one');
    expect(() => validateField({ ...initial, neighbors: [...initial.neighbors, { title: 'Extra', question: 'What is missing?' }] }, undefined, text)).toThrow('at most 8');
    expect(() => validateField({ ...initial, neighbors: Array(8).fill(initial.neighbors[0]) }, undefined, text)).toThrow('distinct');
    const field = makeField(), target = cellAt(field, 0, -1)!;
    expect(() => validateField({ ...initial, targetId: target.id, neighbors: [initial.neighbors[0], { title: 'Floor area', question: 'How large?' }, { title: 'Power', question: 'Is power available?' }] }, field, text)).toThrow('distinct');
  });
});

it('records other discussed topics without moving them or changing focus',()=>{
 const field=makeField(),studio=Object.values(field.cells).find(cell=>cell.title==='Studio')!;
 const proposal={...initial,targetId:field.focusId,summary:'The studio is booked.',sourceQuote:'studio is booked',neighbors:[],updates:[{targetId:studio.id,summary:'Booked for Friday.',sourceQuote:'booked for Friday'}]};
 validateField(proposal,field,'The studio is booked for Friday.');
 const next=applyField(field,proposal,'turn-2');
 expect(next.focusId).toBe(field.focusId);
 expect(next.cells[studio.id]).toMatchObject({x:studio.x,y:studio.y,visited:true,summary:'Booked for Friday.'});
 expect(()=>validateField({...proposal,updates:[{...proposal.updates[0],sourceQuote:'Paid in full'}]},field,'The studio is booked for Friday.')).toThrow('quote');
 expect(()=>validateField({...proposal,targetId:'__proto__'},field,'The studio is booked for Friday.')).toThrow('Unknown field focus');
});
