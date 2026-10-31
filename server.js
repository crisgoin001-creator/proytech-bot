const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Credenciales seguras mediante variables de entorno
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1397037896829310';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'proytech_secure_verify_token';

const SYSTEM_PROMPT = `
Eres el asistente ejecutivo de ingeniería y admisiones de ProyTech Automatización, empresa ubicada en Surquillo, Lima.
Tu objetivo es atender WhatsApp de forma profesional, técnica, humana y cercana.

1. LÍNEA ACADEMIA (ProyTech Academy):
- Capacitaciones especializadas en automatización y control.
- Temarios sólidos: Fundamentos de automatización industrial, programación de PLCs (Siemens S7-1200/1500, TIA Portal, Allen-Bradley), lógica de control y sistemas de seguridad.
- Modalidad: Presencial en Surquillo.
- Duración: 32 horas.
- Reserva: S/ 200 para asegurar el cupo.
- REGLA: NUNCA des el precio total ni fechas exactas de inicio. Haz preguntas de sondeo (qué PLC prefiere, disponibilidad de horarios).

2. LÍNEA SERVICIOS DE INGENIERÍA Y PROYECTOS:
- Ingeniería e integración de sistemas de automatización industrial, migración de PLCs, tableros eléctricos y retrofits de maquinaria.
- Seguridad de máquinas bajo normativas internacionales (ISO 13849-1, IEC 62061, NFPA 70E).
- Control de plataformas Siemens, Rockwell (ControlLogix), robótica (FANUC, KUKA) y variadores (Danfoss, SEW, PowerFlex).
- REGLA: Nunca des precios, tarifas ni plazos/cronogramas de proyectos. Haz preguntas de perfilamiento técnico de manera conversacional (rubro de la planta, tipo de necesidad, modelo de PLC, normativas de seguridad) y genera un bloque [DERIVAR_PROYECTO] al final de tu respuesta para pasar el caso al equipo senior.

3. CONFIDENCIALIDAD ESTRICTA:
- Prohibido dar costos de proyectos, márgenes, datos de SUNAT, contraseñas o información interna.
`;

// 1. Endpoint de Verificación del Webhook (Requerido por Meta)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

// 2. Endpoint para recibir los mensajes reales de los clientes de WhatsApp
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
        try {
            const entry = body.entry?.[0];
            const changes = entry?.changes?.[0];
            const value = changes?.value;
            const messageData = value?.messages?.[0];

            if (messageData) {
                const recipientPhone = messageData.from; // Número del cliente
                const messageText = messageData.text?.body; // Texto del mensaje

                if (messageText) {
                    console.log(`Mensaje recibido de ${recipientPhone}: "${messageText}"`);

                    // Consultar a Claude a través de OpenRouter
                    const aiResponse = await consultarClaude(messageText);

                    // Enviar la respuesta de vuelta por la API oficial de WhatsApp
                    await enviarMensajeWhatsApp(recipientPhone, aiResponse);
                }
            }
            res.sendStatus(200);
        } catch (error) {
            console.error('Error procesando el webhook:', error);
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(404);
    }
});

// Función para consultar a Claude en OpenRouter
async function consultarClaude(userMessage) {
    try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'anthropic/claude-haiku-4.5',
            max_tokens: 400,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMessage }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://proytechautomation.com',
                'X-Title': 'ProyTech WhatsApp Agent'
            }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('Error al conectar con OpenRouter:', error.response?.data || error.message);
        return 'Disculpa, en este momento tengo un pequeño inconveniente técnico. Escríbenos directamente y te atenderemos enseguida.';
    }
}

// Función para enviar mensajes mediante la API de Meta
async function enviarMensajeWhatsApp(toPhone, messageText) {
    try {
        await axios.post(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: 'whatsapp',
            to: toPhone,
            text: { body: messageText }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`Respuesta enviada exitosamente a ${toPhone}`);
    } catch (error) {
        console.error('Error enviando mensaje por WhatsApp API:', error.response?.data || error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor oficial de Meta Cloud API corriendo en el puerto ${PORT}`);
});