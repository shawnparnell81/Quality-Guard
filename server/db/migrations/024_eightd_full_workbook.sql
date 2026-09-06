-- ============================================================
-- 8D: the full workbook, not just the summary sheet.
--
-- eightd has carried two fields (customer, summary) since the
-- schema-driven form system began - real for a placeholder, useless
-- for the actual investigation tool this record type's own workflow
-- (d1 through d8) already implies it should be. The org's real
-- 8D.xlsx is eight worksheets deep: a full identification block, a
-- Kepner-Tregoe root-cause toolkit (Is/Is-Not analysis, Change-How
-- theories), a weighted decision-making matrix, a risk analysis, and
-- a separate systemic prevention-planning worksheet - not only the
-- "Blank 8D" summary sheet. Asked for in full, "for the user to view
-- and use as reference points," since a team walking a real
-- investigation benefits from the same guidance the paper form gave
-- them, not only blank boxes.
--
-- Reused rather than re-asked: the record's own number is 8D No.,
-- opened_at is Date Open, closed_at is Actual Close Date - none of
-- those three are fields here.
--
-- D3 through D7's action tables, the decision matrix, and the
-- prevention plan are all "table" fields (the same type built for
-- APQP's FMEA/control plan) - real rows and columns, not memos.
--
-- The one worksheet that does not fit a table cleanly is Testing
-- Possible Causes: a genuine matrix scoring every theory against
-- every "Is" fact, both axes dynamic. Built as free-text notes with
-- the template's own scoring instructions as its hint, per the
-- user's own framing - "view and use as reference points" - rather
-- than forced into a table shape it does not have.
--
-- Every worksheet's own instructional copy (what a "theory" is, how
-- to score one, the Givens/Wants distinction, the Universal
-- checklist of trouble sources) is carried over as field.hint text -
-- forms.js now renders any field's hint, not only file/signature's
-- hard-coded ones (same commit) - so a user sees the guidance the
-- Excel template gave them without it being mistaken for a data
-- field of its own.
--
-- D7's "reviewed against documents" checklist (FMEA, Flowchart,
-- Control Plan, Work Instructions in the real template) is not a
-- field at all here: it is real links (record_links, POST
-- /:number/links, same mechanism APQP uses to reach its own FMEA/
-- control plan/process flow) from this 8D to the actual documents
-- its D7 touched - a followable reference, not an unverifiable tick
-- box.
-- ============================================================

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id,
       coalesce(prev.version, 0) + 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               -- Identification
               jsonb_build_object('key', 'customer', 'label', 'Customer', 'type', 'text', 'required', true, 'section', 'Identification'),
               jsonb_build_object('key', 'address', 'label', 'Address', 'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'location', 'label', 'Location', 'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'part_no_code', 'label', 'Part No. / Code', 'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'product_name', 'label', 'Product Name', 'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'customer_complaint_no', 'label', 'Customer Complaint No.', 'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'initial_response_date', 'label', 'Initial Response', 'type', 'date', 'section', 'Identification'),
               jsonb_build_object('key', 'target_close_date', 'label', 'Target Close Date', 'type', 'date', 'section', 'Identification'),
               jsonb_build_object('key', 'revision_dates', 'label', 'Revision Date(s)', 'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'initiator', 'label', '8D Initiator', 'type', 'user', 'section', 'Identification'),
               jsonb_build_object('key', 'initiator_supervisor', 'label', '8D Initiator''s Supervisor', 'type', 'user', 'section', 'Identification'),

               -- D1: Team
               jsonb_build_object('key', 'champion', 'label', 'Champion', 'type', 'user', 'section', 'D1 - Team Member Names / Titles'),
               jsonb_build_object('key', 'team_leader', 'label', 'Team Leader', 'type', 'user', 'section', 'D1 - Team Member Names / Titles'),
               jsonb_build_object(
                   'key', 'team_members', 'label', 'Team Members', 'type', 'table', 'section', 'D1 - Team Member Names / Titles',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'name', 'label', 'Name', 'type', 'text', 'width', 100),
                       jsonb_build_object('key', 'title', 'label', 'Title', 'type', 'text', 'width', 100)
                   )
               ),

               -- D2: Problem Statement
               jsonb_build_object('key', 'problem_statement', 'label', 'Problem Statement / Description', 'type', 'memo', 'required', true, 'section', 'D2 - Problem Statement',
                                   'hint', 'What''s wrong with what? Why? Quantify the problem - one defect per 8D.'),

               -- D3: Interim Containment Actions
               jsonb_build_object(
                   'key', 'icas', 'label', 'Interim Containment Action(s) (ICA)', 'type', 'table', 'section', 'D3 - Interim Containment Actions',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'description', 'label', 'Action', 'type', 'text', 'width', 150),
                       jsonb_build_object('key', 'percent_effective', 'label', '% Effective', 'type', 'number', 'width', 60),
                       jsonb_build_object('key', 'target_date', 'label', 'Target Date', 'type', 'date', 'width', 70),
                       jsonb_build_object('key', 'actual_date', 'label', 'Actual Date', 'type', 'date', 'width', 70)
                   )
               ),

               -- D4: Root Cause
               jsonb_build_object(
                   'key', 'root_causes', 'label', 'Verified Root Cause(s)', 'type', 'table', 'section', 'D4 - Root Cause',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'description', 'label', 'Root Cause', 'type', 'text', 'width', 180),
                       jsonb_build_object('key', 'percent_contribution', 'label', '% Contribution', 'type', 'number', 'width', 70)
                   )
               ),
               jsonb_build_object(
                   'key', 'is_is_not', 'label', 'Is / Is Not Analysis', 'type', 'table', 'section', 'D4 - Root Cause',
                   'hint', 'What''s wrong with what? For each dimension, record what IS true, what IS NOT true (a real comparison, not just the absence of the problem), and what to get more information on.',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'dimension', 'label', 'Dimension', 'type', 'text', 'width', 140),
                       jsonb_build_object('key', 'is', 'label', 'Is', 'type', 'text', 'width', 115),
                       jsonb_build_object('key', 'is_not', 'label', 'Is Not', 'type', 'text', 'width', 115),
                       jsonb_build_object('key', 'get_info_on', 'label', 'Get Info On', 'type', 'text', 'width', 115)
                   ),
                   -- The template's own ten dimensions, in its own order -
                   -- a new 8D starts with the framework already right,
                   -- not retyped from scratch each time (forms.js seeds a
                   -- new record's table from defaultRows when there is no
                   -- saved data yet; an existing record's real data always
                   -- wins). The "dimension" column is still a plain text
                   -- cell, not locked - a team that finds the framework
                   -- does not fit their problem can still edit it.
                   'defaultRows', jsonb_build_array(
                       jsonb_build_object('dimension', 'What - Object'),
                       jsonb_build_object('dimension', 'What - Defect'),
                       jsonb_build_object('dimension', 'Where - Seen on object'),
                       jsonb_build_object('dimension', 'Where - Seen geographically'),
                       jsonb_build_object('dimension', 'When - First seen'),
                       jsonb_build_object('dimension', 'When - When else seen'),
                       jsonb_build_object('dimension', 'When - Seen in process (life cycle)'),
                       jsonb_build_object('dimension', 'How Big - How many objects have the defect?'),
                       jsonb_build_object('dimension', 'How Big - How many defects per object?'),
                       jsonb_build_object('dimension', 'How Big - What is the trend?')
                   )
               ),
               jsonb_build_object(
                   'key', 'theories', 'label', 'Change-How Theories', 'type', 'table', 'section', 'D4 - Root Cause',
                   'hint', 'The theories should transfer from the Is/Is Not analysis. For each theory (potential root cause), ask: does it explain, in and of itself, why the Is is affected but never the Is Not?',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'theory', 'label', 'Theory', 'type', 'text', 'width', 300)
                   )
               ),
               jsonb_build_object('key', 'testing_possible_causes_notes', 'label', 'Testing Possible Causes', 'type', 'memo', 'section', 'D4 - Root Cause',
                                   'hint', 'Score each theory against each Is fact: "+" explains both Is and Is Not, "-" does not explain them, "?" need more information to draw a conclusion.'),

               -- Decision-Making Worksheet (D3 & D5)
               jsonb_build_object('key', 'decision_end_result', 'label', 'End Result', 'type', 'memo', 'section', 'Decision-Making Worksheet (D3 & D5)',
                                   'hint', 'State the decision to be made.'),
               jsonb_build_object(
                   'key', 'decision_criteria', 'label', 'Criteria and Choices', 'type', 'table', 'section', 'Decision-Making Worksheet (D3 & D5)',
                   'hint', 'Givens: mandatory, measurable, realistic - a choice failing a Given is eliminated. Wants: flexible, subjective, realistic - weighted by importance (1-10) and scored per choice (0-10).',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'criterion', 'label', 'Criterion', 'type', 'text', 'width', 110),
                       jsonb_build_object('key', 'importance', 'label', 'Importance', 'type', 'number', 'width', 45),
                       jsonb_build_object('key', 'choice_a_info', 'label', 'Choice A - Info', 'type', 'text', 'width', 65),
                       jsonb_build_object('key', 'choice_a_score', 'label', 'Choice A - Score', 'type', 'number', 'width', 40),
                       jsonb_build_object('key', 'choice_b_info', 'label', 'Choice B - Info', 'type', 'text', 'width', 65),
                       jsonb_build_object('key', 'choice_b_score', 'label', 'Choice B - Score', 'type', 'number', 'width', 40),
                       jsonb_build_object('key', 'choice_c_info', 'label', 'Choice C - Info', 'type', 'text', 'width', 65),
                       jsonb_build_object('key', 'choice_c_score', 'label', 'Choice C - Score', 'type', 'number', 'width', 40),
                       jsonb_build_object('key', 'choice_d_info', 'label', 'Choice D - Info', 'type', 'text', 'width', 65),
                       jsonb_build_object('key', 'choice_d_score', 'label', 'Choice D - Score', 'type', 'number', 'width', 40)
                   )
               ),

               -- Risk Analysis (D3 & D5)
               jsonb_build_object(
                   'key', 'decision_risks', 'label', 'Risk Analysis', 'type', 'table', 'section', 'Risk Analysis (D3 & D5)',
                   'hint', 'State risks in IF...THEN terms, one choice at a time - "if we do this, what might happen, contrary to our interest?" Consider: People, Organization, External Influences, Facilities, Equipment, Ideas, Policies.',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'choice', 'label', 'Choice', 'type', 'text', 'width', 90),
                       jsonb_build_object('key', 'risk_statement', 'label', 'If... / Then...', 'type', 'text', 'width', 220),
                       jsonb_build_object('key', 'probability', 'label', 'Probability', 'type', 'number', 'width', 65),
                       jsonb_build_object('key', 'seriousness', 'label', 'Seriousness', 'type', 'number', 'width', 65)
                   )
               ),

               -- D5: Permanent Corrective Action
               jsonb_build_object(
                   'key', 'pcas', 'label', 'Permanent Corrective Action(s) (PCA)', 'type', 'table', 'section', 'D5 - Permanent Corrective Action',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'description', 'label', 'Action', 'type', 'text', 'width', 220),
                       jsonb_build_object('key', 'percent_effective', 'label', '% Effective', 'type', 'number', 'width', 70)
                   )
               ),

               -- D6: Implement & Validate PCA
               jsonb_build_object(
                   'key', 'pca_implementation', 'label', 'Implement and Validate PCA', 'type', 'table', 'section', 'D6 - Implement and Validate PCA',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'description', 'label', 'Action', 'type', 'text', 'width', 180),
                       jsonb_build_object('key', 'target_date', 'label', 'Target Date', 'type', 'date', 'width', 70),
                       jsonb_build_object('key', 'actual_date', 'label', 'Actual Date', 'type', 'date', 'width', 70)
                   )
               ),

               -- D7: Prevention Actions
               jsonb_build_object(
                   'key', 'prevention_actions', 'label', 'Systemic Prevention Actions', 'type', 'table', 'section', 'D7 - Prevent Recurrence',
                   'hint', 'Mistake Proofing: how are you going to ensure it can''t happen again? Reviewed-against-documents evidence goes in Linked records below, not here - link the actual FMEA/control plan/process flow this touched.',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'description', 'label', 'Action', 'type', 'text', 'width', 220),
                       jsonb_build_object('key', 'target_date', 'label', 'Target Date', 'type', 'date', 'width', 70),
                       jsonb_build_object('key', 'actual_date', 'label', 'Actual Date', 'type', 'date', 'width', 70)
                   )
               ),

               -- Plan & Problem Prevention Worksheet
               jsonb_build_object(
                   'key', 'prevention_plan', 'label', 'Plan and Problem Prevention Worksheet', 'type', 'table', 'section', 'Plan & Problem Prevention Worksheet',
                   'hint', 'Identify parts of the plan that are complex, tight-deadline, high-impact, or new. Consider what might go wrong (potential problems), then prioritize by probability x severity before assigning causes, prevention and protection actions.',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'key_step', 'label', 'Key Step', 'type', 'text', 'width', 75),
                       jsonb_build_object('key', 'potential_problem', 'label', 'Potential Problem', 'type', 'text', 'width', 90),
                       jsonb_build_object('key', 'priority', 'label', 'Priority', 'type', 'number', 'width', 40),
                       jsonb_build_object('key', 'possible_causes', 'label', 'Possible Causes', 'type', 'text', 'width', 90),
                       jsonb_build_object('key', 'prevention_actions', 'label', 'Prevention Actions', 'type', 'text', 'width', 90),
                       jsonb_build_object('key', 'protection_actions', 'label', 'Protection Actions', 'type', 'text', 'width', 90),
                       jsonb_build_object('key', 'cue', 'label', 'Cue (Date or Event)', 'type', 'text', 'width', 80),
                       jsonb_build_object('key', 'who', 'label', 'Who', 'type', 'text', 'width', 55)
                   )
               ),

               -- D8: Recognition
               jsonb_build_object('key', 'recognition', 'label', 'Team and Individual Recognition', 'type', 'memo', 'section', 'D8 - Recognition',
                                   'hint', 'Recognize the collective efforts of the team.')
           ),
           'rules', coalesce(prev.schema->'rules', '[]'::jsonb)
       ),
       now()
  from record_types rt
  left join lateral (
        select fv.version, fv.schema
          from form_versions fv
         where fv.record_type_id = rt.id
         order by fv.version desc
         limit 1
       ) prev on true
 where rt.key = 'eightd';
