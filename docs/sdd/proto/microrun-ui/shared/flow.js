window.MRFlow = {
  rollbackSteps(env, target) {
    const steps = [`Образ ${target} узято з локальної закріпленої копії`];
    for (const s of env.services) {
      if (s.strategy === 'rolling') steps.push(`${s.name}: новий контейнер пройшов healthcheck`, `${s.name}: старий контейнер зупинено`);
      else steps.push(`${s.name}: контейнер перестворено`);
    }
    steps.push('Релізи, новіші за ціль, позначено як заблоковані');
    return steps;
  },
  run(steps, onStep, onDone) {
    let i = 0, t0 = Date.now();
    const tick = () => {
      if (i >= steps.length) return onDone(((Date.now() - t0) / 1000 * 4).toFixed(0));
      onStep(i, steps[i]); i++;
      setTimeout(tick, 450 + Math.random() * 400);
    };
    tick();
  },
  fmtN: n => n.toLocaleString('uk-UA'),
};
