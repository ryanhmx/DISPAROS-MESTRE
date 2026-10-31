# Plano: Upload automático de cursos para o Telegram

## Referências pesquisadas

| Repositório | O que aproveitamos |
|---|---|
| [TheCaduceus/tg-upload](https://github.com/TheCaduceus/tg-upload) (arquivado) | Upload recursivo de pasta, legenda com variáveis (`{file_name}`…), miniatura de vídeo |
| [Nekmo/telegram-upload](https://github.com/Nekmo/telegram-upload) | Miniatura e metadados de vídeo; alerta de que o Bot API na nuvem limita a 50 MB |
| [Aviksaikat/Tanpachiro-bot](https://github.com/Aviksaikat/Tanpachiro-bot) | Envio de todos os vídeos de uma pasta; uso do **servidor Bot API local** para passar de 50 MB |
| [tsvetkovv/telegram-course-bot](https://github.com/tsvetkovv/telegram-course-bot) | Número da aula tirado do nome do arquivo |

Nenhum deles junta módulos com hashtags, sumário com links, retomada após queda e painel web. É isso que o Disparos do Mestre passa a ter.

## Decisão sobre o limite de tamanho

- Bot API na nuvem (`api.telegram.org`): **50 MB por arquivo**. Serve para PDFs e aulas curtas.
- Servidor Bot API local ([tdlib/telegram-bot-api](https://github.com/tdlib/telegram-bot-api)): **2 GB por arquivo**, sem mudar o código de envio. Basta trocar a URL base do bot.
- Alternativa descartada: MTProto direto (gramjs), como faz o tg-upload. Também chega a 2 GB, mas exige uma segunda biblioteca de envio, sessão e cache de entidades. O servidor local reaproveita todo o código atual.

O painel ganha um campo **"Servidor Bot API"** na configuração do bot. Vazio = nuvem (50 MB), preenchido = servidor local (2 GB).

## Como funciona

1. **Criar curso**: nome, canal de destino, descrição (vira a mensagem de abertura).
2. **Adicionar arquivos**:
   - pelo navegador, escolhendo a pasta inteira do curso (mantém as subpastas); os arquivos vão um a um, com barra de progresso;
   - ou importando uma pasta que já está no servidor (`COURSES_IMPORT_DIR`), para cursos grandes enviados por SFTP/rclone.
3. **Estrutura automática**: cada subpasta vira um módulo e cada arquivo uma aula, em ordem natural (`Aula 2` antes de `Aula 10`). Títulos editáveis; aulas podem ser puladas ou removidas.
4. **Envio** (fila no servidor, uma mensagem a cada N segundos):
   - mensagem de abertura (se houver descrição);
   - para cada módulo: cabeçalho `📂 Módulo` com hashtag `#M01`;
   - para cada aula: vídeo (streaming, com duração, dimensões e miniatura via ffmpeg quando disponível), foto, áudio ou documento, com legenda do modelo (`{aula}`, `{modulo}`, `{tag}`, `{n}`, `{total}`…) e hashtags `#M01 #M01A03`;
   - no fim, **sumário** com link para cada aula, dividido em várias mensagens se passar de 4096 caracteres, e fixado no canal.
5. **Controle**: pausar, retomar, tentar de novo só as falhas, reenviar sumário. Se o servidor reiniciar, o envio continua de onde parou.
6. **Opções**: proteger conteúdo (bloqueia encaminhar/salvar), apagar arquivos do servidor após o envio, prefixo das hashtags (para vários cursos no mesmo canal), intervalo entre mensagens.

## Tratamento de erros

- 429 (limite do Telegram): espera o `retry_after` e tenta a mesma aula de novo.
- Falha de rede: até 3 novas tentativas com espera crescente.
- Arquivo maior que o limite: aula marcada como falha com orientação para usar o servidor local; o restante continua.
- Bot sem permissão / canal não encontrado / token inválido: o curso pausa com o motivo, em vez de falhar aula por aula.

## Mudanças no código

- `backend/db.js`: tabelas `courses` e `course_items`.
- `backend/bot.js`: URL base configurável (`bot_api_url`) e limite de upload.
- `backend/courses.js`: montagem da estrutura, fila de envio, sumário, retomada.
- `backend/routes/courses.js`: API REST (`/api/courses`), upload por streaming direto para o disco.
- `backend/routes/stats.js`: salvar a URL do servidor Bot API.
- `frontend/courses.html`: página **Cursos** (lista, editor, árvore de módulos, progresso ao vivo).
- `Dockerfile`: instala `ffmpeg` para miniaturas e metadados dos vídeos.

## Como usar

1. Menu **Cursos** → **Novo curso** → escolha o nome e o canal.
2. **Escolher pasta** (ou arraste a pasta) com a estrutura:
   ```
   Meu Curso/
     01 Boas-vindas.mp4          ← aula fora de módulo
     Módulo 1 - Fundamentos/
       Aula 1 - Instalação.mp4
       Apostila.pdf
     Módulo 2 - Funções/
       Aula 1.mp4
   ```
3. Confira a ordem, renomeie ou pule aulas, ajuste a legenda e clique em **Iniciar envio**. Pode fechar a página: o envio continua no servidor.

### Pastas, subpastas e sub-subpastas

Não há limite de níveis. A primeira pasta é o **módulo** 📂; cada nível abaixo é uma **seção** 📁:

| Caminho | Cabeçalho no canal | Hashtags da aula |
|---|---|---|
| `Boas-vindas.mp4` | — | `#A01` |
| `Módulo 1/Aula 1.mp4` | 📂 Módulo 1 `#M01` | `#M01 #M01A01` |
| `Módulo 1/Parte A/Aula 2.mp4` | 📁 Parte A `#M01S01` | `#M01 #M01S01 #M01S01A01` |
| `Módulo 1/Parte A/Extra/Leitura.pdf` | 📁 Extra `#M01S01S01` | `#M01 #M01S01S01 #M01S01S01A01` |

- Tocar em `#M01` no Telegram lista o módulo inteiro; `#M01S01` lista só a seção.
- A legenda mostra o caminho completo (`Módulo 1 › Parte A › Extra`) e o sumário indenta cada nível.
- Dentro de uma pasta, arquivos e subpastas seguem a ordem dos nomes. Para forçar a ordem, numere: `01 Introdução.mp4`, `02 Parte A/`.

### No celular

O celular não deixa escolher uma pasta inteira. Há dois caminhos:

1. **Enviar curso (.zip)**: compacte a pasta (iPhone: Arquivos → segurar a pasta → Comprimir; Android: Arquivos → ⋮ → Compactar). As pastas são mantidas e uma pasta única envolvendo tudo é ignorada.
2. **Adicionar aulas**: escolha os vídeos e depois a pasta de destino (pode criar uma nova, ex: `Módulo 3/Parte A`).

Depois de enviar, o botão 📁 **Mover** muda qualquer aula de pasta. A tela fica ligada durante o envio dos arquivos.

### Assinatura

O campo **Assinatura** (padrão `@mestredoscursoss`, configurável por curso ou pela variável `COURSE_SIGNATURE`) vai no fim da legenda de todas as aulas e no fim do sumário.

## Aulas acima de 50 MB (servidor Bot API local)

1. Pegue `api_id` e `api_hash` em https://my.telegram.org → *API development tools*.
2. Suba o servidor ao lado do painel:
   ```bash
   docker run -d --name telegram-bot-api --restart unless-stopped -p 8081:8081 \
     -e TELEGRAM_API_ID=<api_id> -e TELEGRAM_API_HASH=<api_hash> \
     -v telegram-bot-api-data:/var/lib/telegram-bot-api \
     aiogram/telegram-bot-api:latest
   ```
3. No painel: **Configuração do bot → Avançado** → `http://localhost:8081` (ou `http://telegram-bot-api:8081` se os dois containers estiverem na mesma rede Docker). O painel testa a conexão antes de salvar.

## Cursos grandes direto no servidor

Copie a pasta do curso (SFTP, rclone, `docker cp`) para `backend/data/import/` (ou para o caminho definido em `COURSES_IMPORT_DIR`). Ela aparece no curso em **Importar do servidor**, sem passar pelo navegador e sem ocupar espaço duplicado.
