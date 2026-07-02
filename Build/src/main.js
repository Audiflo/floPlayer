import { Updato } from "@nellowtcs/updato";
import { UpdateNotification } from "@nellowtcs/updato/update-ui";

// Keep
const updater = Updato.init(
  {
    repo: "NellowTCS/Web-Template",
    mode: "version",
    current: "0.1.0",
  },
  {
    onUpdate: (info) => {
      new UpdateNotification(updater, {
        heading: `v${info.latest} ready`,
      }).show(info);
    },
    onError: (err) => console.warn("Updato:", err.message),
    onProgress: (pct, file) => console.log(`Updato: ${pct}% - ${file}`),
  },
);

function testFunction() {
    console.log('Button clicked!');
    console.warn('This is a warning');
    console.error('This is an error');
    console.info('This is an info');
    console.log('Object:', { name: 'Alice', age: 25, hobbies: ['coding', 'reading'] });
}

function outputToPage() {
    const container = document.body;
    const square = document.createElement('div');
    square.classList.add('square');
    container.appendChild(square);
}
