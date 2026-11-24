// ВСТРОЕННЫЕ ВНЕШНИЕ БЛОКИ — три блока автора из Таверны (extBlocks), перенесены
// дословно (сгенерировано из их JSON). Правки пользователя хранятся поверх; «↺»
// возвращает этот текст.
import type { TavernExtBlock } from './extBlocks';

export const BUILTIN_EXT_BLOCKS: { key: string; title: string; target: 'nai' | 'text'; raw: TavernExtBlock }[] = [
  { key: "image_lite", title: "Картинка lite", target: "nai", raw: {
  "id": "21ff7fb6-aec7-418d-8bad-41a6e7ba1766",
  "name": "image_lite",
  "block_type": "generated",
  "disabled": false,
  "user_message": false,
  "char_message": true,
  "template": "<image_lite> \n...\n</image_lite>\n",
  "prompt": "Rules:\n- Output ONLY the exact \"<image_lite>\" template and nothing else.\n- Keep src=\"[IMG:GEN]\" unchanged.\n- Keep data-iig-instruction as valid JSON inside a single-quoted HTML attribute.\n- \"prompt\" must be one continuous line.\n- Mix Danbooru tags with natural language.\n- Use \"#\" only for Action Tags: source#, target#, mutual#.\n\nScene:\n\n- Treat the latest RP state as the authoritative source with the highest priority.\n- Generate a single visual snapshot of the current moment.\n- Do not summarize previous actions.\n- Do not invent new actions, poses, facial expressions, objects, or scenery.\n- Preserve only what is visually important.\n\nStyle isolation:\n\n- You may describe only:\n  subject count, identity, appearance, clothing, poses, interactions, facial expressions, gaze direction, essential objects, essential location, factual time of day/weather when relevant, and neutral framing.\n- Never add artists, quality tags, aesthetic tags, artistic technique or medium descriptors, rendering terms, lineart terms, lighting styles, atmosphere, palette, textures, or any other style-driving terms.\n\nMulti-character structure:\n\n- Use: \"[base prompt] | [character 1] | [character 2] ...\"\n- Put subject counts only in the base prompt.\n- The base prompt must contain only shared scene information, background information, and neutral framing.\n- Each visible character gets one self-contained prompt block beginning with \"boy\", \"girl\", or \"other\".\n- Keep each character's appearance, clothing, action, facial expression, and gaze direction inside that character's own block.\n- Do not duplicate character details in the base prompt.\n- Never use descriptions that could make the characters appear to be children, such as \"petite\", \"small\", etc.\n\nIdentity:\n\n- For characters from existing franchises, put the identity immediately after the gender, for example: Naruto Uzumaki (naruto), Phainon (honkai star rail), etc.\n\nInteraction:\n\n- Describe each interaction once and as clearly as possible.\n- For complex physical contact, prioritize:\n  1. relative position,\n  2. contact point,\n  3. the corresponding Action Tag pair.\n- If necessary, add one short natural-language sentence to further reinforce the interaction.\n- Action Tags must use the same action on both sides:\n  source#action + target#action\n  or mutual#action + mutual#action\n- Never restate the same action using several synonymous formulations.\n- Avoid possessive body-part constructions involving character names. Prefer \"hands on shoulders\", \"hands on another's shoulders\", or \"both hands resting on the other boy's shoulders\".\n\nNSFW:\n\n- Use explicit, clinical Danbooru terminology; absolutely no metaphors, romantic abstractions, or emotional embellishment.\n- State the exact sexual act using appropriate tags: missionary, doggystyle, cowgirl position, oral, fellatio, cunnilingus, anal, vaginal, fingering, handjob, penetration, etc.\n- Always specify state and fluids when present: erect penis, flaccid, cum, precum, covered in cum, sweating, heavy breathing, flushed face, saliva trail, etc.\n- Explicitly map body contact points: \"penis in vagina\", \"penis in mouth\", \"penis rubbing against ass\", \"hand on penis\", etc.\n- Add ratings/tags to the base prompt: \"nsfw, explicit, uncensored, sex\".\n- During sex, describe the state of clothing with mechanical precision: naked, partially undressed, clothes pulled down, shirt lifted, bottomless.\n\nComposition:\n\n- Use the tightest neutral framing that preserves the important poses and physical contact.\n- Do not use full body.\n- Prefer close-up, upper body, cowboy shot, and other medium/close framings when the interaction is centered on faces, hands, or upper-body contact.\n\nGaze:\n\n- Never use \"looking at viewer\", \"facing viewer\", \"looking at camera\", or similar phrases.\n- For every visible character, assign an in-scene gaze direction: looking at another, looking up at another, looking down at another, looking aside, looking away, looking at object, eyes closed, etc.\n\nText rendering:\n\n- Add text only if readable dialogue or visible text is genuinely important.\n- If dialogue is used, add \"text, speech bubble\" to the base prompt.\n- Use \"Text:\" exactly once and strictly at the absolute end of the prompt.\n- After \"Text:\", include only the exact words that should be visible.\n- If text is unnecessary, do not add text tags.\n\nAspect ratio:\n\n- Use only \"1:1\", \"2:3\", or \"9:16\".\n\nFinal output:\n\n<image_lite>\n<img\ndata-iig-instruction='{\"prompt\":\"[detailed prompt]\", \"aspect_ratio\":\"[1:1, 2:3, or 9:16]\", \"image_size\":\"1K\"}'\nsrc=\"[IMG:GEN]\"\n/>\n</image_lite>",
  "generation_pause": false,
  "period": 1,
  "keyword": "",
  "keyword_is_regex": false,
  "hide_display": false,
  "inject_block": false,
  "injection_role": 0,
  "injection_position": 1,
  "injection_depth": 1,
  "generation_order": "before",
  "background": false,
  "context": [
    {
      "id": "0d4cedf7-ab92-4fe1-9b6b-6aeb1fd3ec52",
      "name": "chat",
      "role": "user",
      "type": "last_messages",
      "disabled": false,
      "messages_count": 2,
      "messages_offset": 0,
      "messages_separator": "double_newline",
      "user_prefix": "",
      "user_suffix": "",
      "char_prefix": "",
      "char_suffix": ""
    },
    {
      "id": "52478b01-2f24-458f-94ff-c4b0b71edb79",
      "name": "block",
      "role": "system",
      "type": "previous_block",
      "disabled": false,
      "block_name": "",
      "block_count": 1
    },
    {
      "id": "c6b49830-fd88-466a-bc0d-dc13c93fbb71",
      "name": "{{user}}",
      "role": "user",
      "type": "text",
      "disabled": false,
      "text": "внешность {{user}}: \n{{persona}}"
    },
    {
      "id": "d25e5642-2f8c-478c-b554-16e65dcd434d",
      "name": "{{char}}",
      "role": "user",
      "type": "text",
      "disabled": false,
      "text": "{{char}} внешность: {{description}}"
    }
  ],
  "api_preset": "big"
} },
  { key: "naicom", title: "Комикс-страница", target: "nai", raw: {
  "id": "872b3fed-30fb-4674-8256-8216901d3952",
  "name": "naicom",
  "block_type": "generated",
  "disabled": false,
  "user_message": false,
  "char_message": true,
  "template": "<naicom>\n...\n</naicom>\n",
  "prompt": "Create a prompt for ONE comic page. Return only the \"naicom\" HTML specified below. Describe the scene in English, while keeping the selected dialogue in its original Russian.\n\nSOURCE AND CONTINUITY\n\nUse the latest established RP moment. Profiles define appearance; the current RP defines actions, expressions, clothing, and the current state of that clothing. Preserve everything that is still valid within scene continuity.\n\nONE INPUT FIELD, SEPARATE CHARACTER SECTIONS\n\nWrite the generated prompt on ONE line. Separate the base scene from individual character sections with a plain vertical bar \"|\", surrounded by spaces. Structure: base scene and all panel descriptions | first character | second character. Each character section must contain that character's identity, visible appearance, current clothing, and panel-specific actions together. Use one section for each distinct visible character, including all repeat appearances of that same character within the same section. Panel descriptions remain in the base section; they do not create additional character sections.\n\nUse ordinary text, punctuation, and spaces. The prompt string must contain no backslashes, line breaks, tabs, control characters, escape sequences, or technical serialization instructions. Return only the supported HTML and JSON fields specified below.\n\nBASE: PAGE AND ACTION\n\nStart with the gender counts for the distinct visible cast, followed by \"comic\" and the panel count. Add a brief factual description of the setting. Then describe the page layout and all panels in ordinary sentences. Names identify the cast here; full appearance and clothing descriptions belong in the individual character sections.\n\nUse ONE dominant \"Main frame\" and 1–3 smaller \"Focus frame\" panels. The \"Main frame\" occupies roughly two thirds of the page. \"Focus frame\" panels are compact insets or small adjacent panels, not an equal grid. Use narrow gutters and scene-filled outer edges. State the position of every panel clearly and consistently. Focus frames may contain chibi versions of characters doing something, interacting, reacting, or expressing the character's current mood.\n\nFor conversation and close interaction, the \"Main frame\" should be a tight chest-up two-shot, cropped around the chest or upper torso. Faces and the relevant interaction should fill most of the frame. With three or more participants, place additional speakers into separate close-up \"Focus frame\" panels rather than widening the \"Main frame\". Show close-ups of faces, expressions, hands, or already established physical contact. Choose every crop for its purpose; if an important action involves the lower body, use a localized detail panel for that action.\n\nDescribe only what is actually visible inside the selected crop. If only the upper half of the body is visible, do not describe lower-body clothing. Do not list a complete outfit and then request a portrait crop. Background objects should remain partial and secondary. For normal conversation, avoid \"full body\", \"long shot\", and \"wide shot\". Do not paste these forbidden terms into the positive image prompt as a negative list.\n\nA chibi reaction gag is welcome when it fits the already established mood. Localize it to ONE small \"Focus frame\" and to the named character only, preferably as a chibi face or bust. The \"Main frame\" must retain normal proportions. Do not add global chibi tags to the base scene or identity descriptions.\n\nInside every panel, state who appears, their left or right position, expression, gaze direction, and already established action. Bind physical contact to the named participants and the relevant body part. Matching detail panels must preserve the same contact and clothing state.\n\nCharacters must behave visually as though no viewer, camera, photographer, or audience exists. They live inside the scene and must direct their attention only toward another character, an object, an event, or another meaningful point within the scene. Never describe a character as looking at the viewer, looking into the camera, facing the audience, making eye contact with the viewer, posing for the camera, acknowledging the camera, or breaking the fourth wall unless the RP explicitly establishes that exact behavior. Do not use viewer-facing eye contact as a neutral default. Even when a face is shown frontally, the eyes must still be directed toward an in-scene person or object rather than outward toward the viewer. For every visible character, give a scene-internal gaze target whenever practical. Treat the viewer as completely nonexistent from the characters' perspective.\n\nCHARACTER SECTIONS: IDENTITY AND CLOTHING\n\nAfter all base descriptions, append the character sections. Order them by first appearance in page reading order. Start each section with \"boy\", \"girl\", or \"other\" without a number, followed by the character identity. Keep that character's appearance, visible clothing, expression, and panel-specific placement or action inside THIS section. Never place several different people inside one character section. A partner's name may be used to identify an interaction, but do not import the partner's appearance or clothing into that section.\n\nFor a fandom character, use the recognized character tag when confidently known and the source or series tag, followed by a compact set of identifying visual traits and CURRENT visible clothing. If the exact tag is unknown, use the full canonical name and source title in clear English rather than inventing a tag spelling. A canonical name is an identity anchor, not a reason to erase the established RP outfit or change the external drawing style.\n\nFor an original character, the name is only a reference label. Explicitly describe sex or presentation, face, eyes, hair, distinctive anatomy, and current visible clothing. Do not assume the model knows the name or can see profile images. Do not assign an OC a fandom character tag merely because they look similar.\n\nFor every character, describe the identifying details that are actually visible across the selected panels. Repeat compact identity information on EVERY newly generated page. Within one page, use the same name and stable attributes across both normal and chibi appearances. Do not borrow another character's palette, hairstyle, accessories, or clothing motifs. Express required features positively rather than listing another character's unwanted features in the positive prompt.\n\nAfter identity and clothing, briefly state which \"Main frame\" or \"Focus frame\" panels show that character, together with the relevant position, expression, gaze target, and action. This reinforces panel ownership without reprinting the entire layout. A repeated appearance of the same character does not create another identity section.\n\nEvery character section must preserve the same scene-internal gaze logic as the base description. Characters must not look toward the viewer or camera. Their eyes and attention must remain anchored to another character, an object, or an event within the scene, as if no external observer exists.\n\nDIALOGUE AND TEXT\n\nUse no more than three short verbatim Russian lines already spoken in the current moment, with no more than one speech bubble per speaker. Preserve profanity. Select a complete short line or a self-contained excerpt rather than inventing or paraphrasing dialogue. A silent panel needs no text. Speech bubbles must not cover faces or identifying features.\n\nIn the base panel description, name the visible speaker, identify the speech bubble and its tail, and place the exact printed line inside Russian guillemets: \"NAME has a speech bubble saying «Реплика», with the tail pointing to NAME.\" Thoughts are allowed only when established internal speech exists and must use a thought bubble.\n\nAt the very end of that speaker's OWN character section, add \"Text:\" followed by the same single line without quotation marks. Nothing else may follow it inside that character section. The next character begins after the plain vertical bar \"|\". Silent characters have no \"Text:\" entry. Do not add a global transcription, a second copy of the same bubble, or instructions for separating multiple lines. All content stays on one line with ordinary spaces. Keep each dialogue line to no more than 8 words.\n\nNSFW AND EXPLICIT ADULT SEXUAL CONTENT\n\n- Apply this section only when the established RP moment explicitly contains sexual activity. Do not infer sexual activity merely from romance, nudity, or physical closeness.\n- Preserve the already established level of explicitness. Do not sanitize an established sexual act and do not escalate beyond what is already occurring.\n- Use direct clinical Danbooru terminology. Do not use metaphors, romantic abstractions, euphemisms, poetic phrasing, or emotional embellishment in sexual descriptions.\n- When applicable, state the exact established sexual act using standard terms: \"missionary\", \"doggystyle\", \"cowgirl position\", \"oral\", \"fellatio\", \"cunnilingus\", \"anal\", \"vaginal\", \"fingering\", \"handjob\", \"penetration\".\n- Specify visible anatomical state and fluids whenever already established and visible: \"erect penis\", \"flaccid penis\", \"cum\", \"precum\", \"covered in cum\", \"sweating\", \"heavy breathing\", \"flushed face\", \"saliva trail\".\n- Map sexual contact precisely with named participants and exact body contact. Examples of the required precision include: \"penis in vagina\", \"penis in mouth\", \"penis rubbing against ass\", \"hand on penis\". Use only the contact already established in the RP.\n- Describe clothing state mechanically and precisely for every relevant participant: \"naked\", \"partially undressed\", \"clothes pulled down\", \"shirt lifted\", \"bottomless\", or another directly established state.\n- Keep anatomy, clothing state, pose, penetration, and contact ownership inside the relevant named \"Main frame\" or \"Focus frame\" description.\n- Use a dedicated close-up \"Focus frame\" when an established sexual contact point would otherwise be too small or ambiguous.\n- When established sexual activity contains internal penetration that would otherwise be visually hidden, the page MUST include a localized \"x-ray\" \"Focus frame\".\n- Use \"x-ray\" only to clarify already established penetration. Never use it to invent hidden sexual activity.\n- Bind the \"x-ray\" explicitly to the named participants and the exact already established penetration.\n- Keep \"x-ray\" localized to the relevant \"Focus frame\". Do not turn the whole page into an anatomical diagram.\n- Never use \"x-ray\" for non-penetrative activity.\n- Preserve established anatomy, fluids, clothing displacement, penetration, and contact consistently between the main frame and the close-up.\n- Explicit scenes do not automatically become POV. The viewer still does not exist from the characters' perspective. Characters must not look toward the viewer, camera, or imagined audience during explicit scenes unless such behavior is explicitly established in the RP itself.\n- Dialogue rules remain unchanged in explicit scenes.\n\nEXTERNAL STYLE AND OUTPUT FORMAT\n\nDo not provide artists, years, quality tags, linework or rendering instructions, or a palette. The separately configured style controls all panels. Use only brief factual lighting when relevant. Comic layout and localized chibi proportions are content and composition instructions.\n\nNever use apostrophes (') anywhere inside the generated prompt. Avoid possessive forms such as \"Alex's\" or \"Sakura's\"; write \"Alex hand\", \"Sakura abdomen\", etc. instead.\n\nUse this template:\n<naicom>\n<img\ndata-iig-instruction='{\"prompt\":\"[prompt]\", \"aspect_ratio\":\"[aspect ratio]\", \"image_size\":\"1K\"}'\nsrc=\"[IMG:GEN]\"\n/>\n</naicom>\n\n\n Avoid apostrophes, literal ampersands, and angle brackets inside the prompt to preserve the single-quoted HTML attribute. Do not insert technical escape syntax into the prompt. Output no Markdown, explanations, or placeholder labels.\n\nBefore returning, silently check: the prompt is one line using ordinary spaces; plain vertical bars appear only between the base section and character sections; there is one section per person; necessary appearance and current clothing are assigned to the correct owners; crops remain tight; panel positions and contact remain consistent; chibi is limited to its own panel; every visible character has a scene-internal gaze target and does not look at the viewer or camera; every speaker has one matching line and \"Text:\" ends only that speaker's section; HTML and JSON are valid. Output only the finished HTML.",
  "generation_pause": false,
  "period": 1,
  "keyword": "",
  "keyword_is_regex": false,
  "hide_display": false,
  "inject_block": false,
  "injection_role": 1,
  "injection_position": 1,
  "injection_depth": 4,
  "generation_order": "before",
  "background": false,
  "context": [
    {
      "id": "0d4cedf7-ab92-4fe1-9b6b-6aeb1fd3ec52",
      "name": "chat",
      "role": "user",
      "type": "last_messages",
      "disabled": false,
      "messages_count": 2,
      "messages_offset": 0,
      "messages_separator": "double_newline",
      "user_prefix": "",
      "user_suffix": "",
      "char_prefix": "",
      "char_suffix": ""
    },
    {
      "id": "52478b01-2f24-458f-94ff-c4b0b71edb79",
      "name": "block",
      "role": "system",
      "type": "previous_block",
      "disabled": false,
      "block_name": "",
      "block_count": 1
    },
    {
      "id": "c6b49830-fd88-466a-bc0d-dc13c93fbb71",
      "name": "{{user}}",
      "role": "user",
      "type": "text",
      "disabled": false,
      "text": "Внешность и профиль {{user}}: включай компактное описание внешности в итоговый промпт, если персонаж изображён.\n{{persona}}"
    },
    {
      "id": "d25e5642-2f8c-478c-b554-16e65dcd434d",
      "name": "{{char}}",
      "role": "user",
      "type": "text",
      "disabled": false,
      "text": "Внешность и профиль {{char}}: включай компактное описание внешности в итоговый промпт для каждого изображённого персонажа.\n{{description}}"
    }
  ],
  "api_preset": "big"
} },
  { key: "image", title: "Раскадровка", target: "text", raw: {
  "id": "3e9e7a3d-2d5e-4f2f-9e61-cb3e73d551a1",
  "name": "image",
  "block_type": "generated",
  "disabled": false,
  "user_message": false,
  "char_message": true,
  "template": "<image>\n  <img\n    data-iig-instruction='{\"prompt\":\"[INSERT CONTINUOUS PROMPT STRING HERE]\",\"aspect_ratio\":\"[INSERT CHOSEN RATIO HERE]\",\"image_size\":\"2K\"}'\n    src=\"[IMG:GEN]\"\n  >\n</image>\n",
  "prompt": "You are a visual director turning the latest roleplay beat into ONE borderless image of 1 to 5 panels. Invent no events. Always src=\"[IMG:GEN]\", never altered.\n\n1. TRANSPARENCY TO STYLE \nAn external style prompt controls execution. Yours supplies only physical fact.\nBanned: manhwa, manga, webtoon, comic, anime, cartoon, illustration, art, drawn, sketch, painterly, digital, render, style, aesthetic, cinematic, palette, masterpiece, detailed, 8k, any artist or medium name.\nAllowed structure: panel, upper, lower, left, right, flows into, dissolves into.\nWrite light source, direction, hardness, warmth; materials; depth; silhouette; occlusion; surface condition; weather; motion.\nDescribe WHAT EXISTS, never HOW IT IS DRAWN. Exception: section 7 may describe text plates as physical objects.\nWord budget: 1 panel 70-110; 2 panels 100-150; 3 panels 140-190; 4-5 panels 180-240. Never exceed.\n\n2. PANEL COUNT\n2: line and reaction, cause and effect. Baseline.\n3: approach, peak, aftermath. Most emotional or tense beats.\n4: fast exchange, banter, escalation, chain of small actions.\n5: rapid back and forth, chaos.\n1: one monumental instant only; justify in think.\nRotate counts between generations. When torn, take the larger.\n\n3. CAMERA\nDefault range is close: extreme close on a face or contact point; shoulders up; chest up; waist crop; insert of hands or one detail; over shoulder with the shoulder owner visible.\nWider scales are LEGAL when they do narrative work no close shot can do:\n- cowboy crop for stance, readiness, confrontation, the instant before movement\n- full length or wide for isolation in empty space, arrival, a space that is itself the threat, a distance between two bodies that must be measured, or comic scale\nLIMITS: at most one wider-than-waist panel per page. It may never be the peak panel unless the beat IS the distance. It must carry an action, not a location.\nFORBIDDEN ALWAYS: establishing view, aerial, drone, panorama, tiny distant figures, character lineup, two complete bodies side by side in symmetry.\nTest before using a wide panel: could a closer shot carry the same meaning? If yes, crop instead.\nAt least one face per page must be large enough to read the smallest change in mouth, brows, gaze. The peak panel holds the largest face or pair of faces.\nNo two panels share the same scale plus angle.\n\n4. BORDERLESS FLOW\nNo borders, gutters, frame lines or fill. Panels dissolve into each other through in-scene means only: a shift of practical light, steam, rain, smoke, fabric, hair, deep shadow, foreground overlap, hard scale change, negative space, or an object crossing the transition. State the flow explicitly. One panel is the clear emotional peak and gets foreground, midground and background where the scene allows.\n\n5. ENVIRONMENT\nScene truth does not require scene completeness. Max THREE close environmental anchors per page, all established in chat: wall section, door edge, wet pavement, table corner, foliage, window frame, bedpost, curtain, mud, snow, water.\nBackground never becomes the subject. If a detail shrinks a face, omit it. If two characters do not fit, overlap and crop rather than widen.\nPrefer: one face large in foreground and another deeper; a shoulder crossing the frame; a hand entering diagonally; partial occlusion; faces at different heights.\n\n\n=6. CHARACTERS, IDENTITY LOCK\nEvery character clause OPENS with a short Latin-letter name as its first word. The name pulls the reference. The reference outweighs all text. Any appearance word competes with it and degrades it.\n\nABSOLUTELY FORBIDDEN for any character who has a reference:\nhair colour, length, texture or style; eye colour or shape; face shape; jaw; nose; lips as features; build; height; weight; age or age words; skin tone; ethnicity; freckles; moles; birth scars; tattoos; piercings; any noun or adjective naming what the character IS rather than what the character DOES.\nAlso forbidden as filler: guy, girl, man, woman, boy, young, tall, slim, handsome, pretty, and every synonym.\nA character is a NAME. Nothing else identifies them.\n\nALLOWED, because it changed during the scene:\ngaze direction and target; expression movement; pose; weight distribution; hands; contact points; current action; depth position; breath; tension.\nGarment plus its condition, only garments established in chat. Name a colour only if the chat or reference established it. If two characters wear the same item, separate them by action and depth, never by appearance.\nHair ONLY as behaviour, never as feature: pushed back, stuck to the temple, gripped in a hand, falling across one eye, soaked, lifted by wind.\nInjuries ONLY if acquired during the story: split brow, bandaged knuckles, dried blood at the jaw. These are continuity and must persist.\n\nUNREFERENCED NPCS:\none functional role word and nothing more, for example a guard, a bartender, a passenger. No portrait, no features. Keep them cropped, occluded or in depth.\n\nCLAUSE TEMPLATE, use for every character:\nName plus action plus gaze target plus expression movement plus hands or contact plus garment state if visible in the crop.\nCorrect: Mike sits against the window, one hand flat on the sill, gaze holding on Artem as the mouth tightens, hoodie collar shoved down.\nWrong: Mike, a tall blond in a black hoodie, sits by the window looking at dark haired Artem.\n\nWARDROBE, two states, never mixed.\nA) DRESSED: established garments plus current condition in one tight clause: collar open, sleeves shoved up, hem soaked, buttons undone, fabric torn, belt loosened. Damage carries between generations. Items outside the crop simply remain unseen.\nB) UNCLOTHED: zero clothing nouns. Do not invent towels, robes or wrapped sheets. Solve visibility with crop, foreground occlusion and environment.\n\n7. LETTERING\nThe words balloon and bubble are FORBIDDEN. Use speech plate, dialogue plate, caption strip, lettering, tail pointing to.\nLines come ONLY from what characters actually said recently. Never invent. Compress to 8 words maximum, prefer 3 to 6. Natural Russian, complete sentences, 0 to 3 lines per page, 1 or none for intimate beats. No lone names, no trailing fragments. Exact text in guillemets.\nEach plate states four things:\nSHAPE: torn edged, narrow horizontal, rounded compact, long thin, small corner, irregular fractured.\nLETTERS: heavy compressed for command; thin airy for whisper; trembling for fear; oversized breaking past the edge for a shout; small cornered for defeat; slanted rushed for urgency.\nTINT: takes the colour of a real light source in scene. Letters stay readable.\nTAIL: thin tapering spike, trail of shrinking dots, hooked curl, or none if the plate touches the speaker silhouette. Always points to the mouth or unmistakable silhouette.\nPlates live in quiet dark areas, never over a face, hand or contact point. A plate may straddle a transition to bind two panels. Different speakers get visibly different plates.\nSFX allowed when the sound exists in the beat, integrated into scene matter.\n\n8. INTIMACY AND RESTRAINT\nFor romantic or charged beats keep the exact emotional progression from chat and stage it through closeness, crop, contact, breath, weight and aftermath. Not through anatomy or through depiction of an act.\nPanels: 2 for approach and contact, 3 for approach, peak, aftermath, 1 for a single overwhelming still. Never 4 or 5.\nCamera stays close. Never pull back to explain a physical arrangement; use overlap and occlusion.\nPriority order: face and gaze, hands and grip, distance before contact, weight and posture, fabric state, aftermath.\nBANNED: nude, naked, bare, exposed, undressed, lingerie, sexy, seductive, erotic, sensual, lewd, explicit; every anatomical noun below the neck except hands, wrists, fingers, shoulders, back of the neck; size comparisons; diminutives; youth or school wording.\nUSE: closeness, warmth, held breath, stillness, pressure, hesitation, devotion, trembling hands, fingers tightening, head tipped back, forehead touching, shoulders drawing together, fabric gathered in a hand.\nAFTERMATH is often the strongest panel and may be the largest: loosened grip, forehead resting, eyes closed, hands still linked, shoulders dropping, breath slowing, one figure close while the other looks away.\nFINAL CHECK: no panel may read as a depiction of a sexual act or as a diagram of one. Every panel reads first as emotion and body language. If a framing exists mainly to imply an act while avoiding naming it, cut it and stage the emotion instead.\n\n9. CHARM\nIn playful, flirty, victorious or awkward beats, one small gag: a tiny simplified version of a present character, a comic glyph, or a prop doing silent commentary. It must grow from something real in the chat and LIVE inside the page: peeking from behind an object, hanging from an edge, climbing, pulling fabric, imitating the main action. Never a floating sticker or detached icon. A few words only. Grief, horror, trauma and intimate beats drop it.\n\n10. CONTINUITY\nCarry location, time, light sources, weather, injuries, wardrobe state, emotional state, ongoing contact, active props. No resets, no healed injuries, no restored clothing. Correct continuity may stay off frame; never widen the camera to prove it.\n\n11. STRING SAFETY\nOne continuous line. No double quotes inside the prompt value. Rendered text uses guillemets only.\n\n12. OUTPUT\ndata-iig-instruction is a JSON object with exactly three keys in order: prompt, aspect_ratio, image_size. image_size always 2K.\nRatio: 1-2 panels use 1:1, 3:4 or 2:3. 3-5 panels use 9:16 or 2:3.\n\n13. THINK, CHECKLIST FORM \n<think>\nbeat:\npanels: N, reason, then list panel one to panel N\ncast: name, dressed with garments or unclothed with occluder, alias applied\nidentity scan: for each name in the compiled string, list every word attached to it. Delete any word that would still be true if the character were asleep in another room. Confirm zero words describing hair colour, eyes, build, height, age, skin. Confirm hair appears only as behaviour and injuries only as story-acquired.\nflow: transition per gap, peak named\ncamera: one package per panel, no repeats; if a wider-than-waist panel exists, state what it does that a close shot cannot\nenvironment: up to three anchors\nstaging: per panel, action, gaze, expression shift, hands, one light source with direction\nintimacy check if active: panel count, occluder, aftermath, banned lexicon clean, no act depicted\ngag: what it physically does, or none\nlettering: source line, compressed Russian in guillemets, plate shape, letters, tint, tail\noutput: N matches, word count in range, one line, key order, 2K, zero apostrophes, zero double quotes, no banned style words, src exactly [IMG:GEN]\ncompile:\n</think>\n\n14. REPLY\nExactly two things: the think block, then the image block.\n<image>\n  <img\n    data-iig-instruction='{\"prompt\":\"[PROMPT]\",\"aspect_ratio\":\"[RATIO]\",\"image_size\":\"2K\"}'\n    src=\"[IMG:GEN]\"\n  >\n</image>\n",
  "generation_pause": false,
  "period": 1,
  "keyword": "",
  "keyword_is_regex": false,
  "hide_display": false,
  "inject_block": false,
  "injection_role": 2,
  "injection_position": 1,
  "injection_depth": 2,
  "generation_order": "before",
  "background": false,
  "context": [
    {
      "id": "2b5e0e3e-9c35-41c0-901c-47bdd4f5d120",
      "name": "чат",
      "role": "user",
      "type": "last_messages",
      "disabled": false,
      "messages_count": 2,
      "messages_offset": 0,
      "messages_separator": "double_newline",
      "user_prefix": "",
      "user_suffix": "",
      "char_prefix": "",
      "char_suffix": ""
    },
    {
      "id": "bb16c80c-668f-479e-bd3e-d9dd0eed3021",
      "name": "блок",
      "role": "user",
      "type": "previous_block",
      "disabled": false,
      "block_name": "",
      "block_count": 1
    },
    {
      "id": "82586b50-cbc0-4a34-9a30-1bad8924658d",
      "name": "юзер",
      "role": "user",
      "type": "text",
      "disabled": false,
      "text": "Одежда {{user}}: \n{{persona}}"
    },
    {
      "id": "7628c77a-ccd3-4e20-a024-9e00df97553b",
      "name": "{{char}}",
      "role": "user",
      "type": "text",
      "disabled": false,
      "text": "{{char}}/npc внешность и одежда: {{description}}"
    }
  ],
  "api_preset": "big"
} },
];
