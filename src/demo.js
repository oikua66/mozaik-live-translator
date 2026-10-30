import { SemanticEvent } from "@mozaik-ai/core";
import { initializeRuntime, join, sendEvent } from "./runtime.js";
import { TranslatorState } from "./runtime.js";
import { inputAgent, translatorAgent, editorAgent } from "./agents.js";

initializeRuntime({
  state: new TranslatorState({ sourceLanguage: "ru", targetLanguage: "en" }),
});

join(inputAgent);
join(translatorAgent);
join(editorAgent);

const fragments = [
  "Добрый день.",
  "Я хотел бы перенести нашу встречу на завтра.",
  "Сегодня я не успеваю закончить документы.",
  "Если вам удобно, давайте встретимся завтра после трёх часов.",
];

console.log("\n🚀 Mozaik Live Translator — text pipeline demo");
console.log("Three role agents share one runtime. New source fragments arrive while earlier fragments are translated/edited.\n");

for (let i = 0; i < fragments.length; i += 1) {
  setTimeout(() => {
    const event = SemanticEvent.create(
      "source.fragment",
      inputAgent.getId(),
      { id: i + 1, text: fragments[i] },
    );
    sendEvent(event, inputAgent.getId());
  }, i * 700);
}

setTimeout(() => {
  console.log("\nDemo input finished. Agent loops continue until their queues are empty.");
}, fragments.length * 700 + 200);
