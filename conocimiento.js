// =====================================================================
// BASE DE CONOCIMIENTO DEL BOT — edita este archivo sin tocar server.js
// Todo lo que el bot "sabe" sale de aquí. Si algo no está aquí, el bot
// NO lo inventa: responde con cautela y te avisa (confianza baja).
// =====================================================================

module.exports = `
# EMPRESA
- ProyTech Automatización E.I.R.L. (Lima, Perú). Laboratorio y oficina: Av. Víctor Alzamora 384, Surquillo.
- Web: https://proytechautomation.com
- Dos líneas: SERVICIOS de ingeniería y ACADEMY (capacitación).

# LÍNEA SERVICIOS DE INGENIERÍA
Qué hacemos:
- Ingeniería e integración de automatización industrial, programación de PLC y HMI.
- Migración de PLC (ej. S7-300 → S7-1500), retrofit de maquinaria, tableros eléctricos y de control.
- Seguridad de máquinas bajo ISO 13849-1, IEC 62061 y NFPA 70E.
- Plataformas: Siemens, Rockwell (ControlLogix/CompactLogix), robótica FANUC y KUKA, variadores Danfoss, SEW y PowerFlex.
Datos que necesitamos para perfilar (pedir UNO por mensaje, solo los que falten):
1. Empresa y rubro de la planta.
2. Necesidad concreta (falla, mejora, proyecto nuevo, migración, seguridad).
3. Equipos/marca de PLC involucrados.
4. Ubicación de la planta.
5. Urgencia (parada de planta / plazo deseado).
Políticas:
- NO dar precios, tarifas ni plazos de proyectos: se cotizan tras evaluación técnica.
- Con rubro + necesidad identificados → derivar al ingeniero (derivar=true).

# LÍNEA ACADEMY — Curso PLC Siemens y HMI
- 100% presencial en el laboratorio de Surquillo. Landing: https://proytechautomation.com/proytech-academy/
- 32 horas en 4 sesiones de 8 h (9:00 a.m. a 6:00 p.m.).
- Equipos reales: PLC S7-1200 (CPU 1212C), TIA Portal V20, HMI KTP700 y WinCC sobre tableros reales. Máximo 2 alumnos por estación.
- Incluye certificado, manual impreso, proyectos base y soporte post-curso.
- Modalidades de grupo: sábados, entre semana (miércoles y viernes) o domingos.
- Reserva de cupo: S/ 200. Pagos: Yape, Plin, transferencia o tarjeta. Se emite boleta o factura.
Datos para perfilar (uno por mensaje): experiencia previa en PLC, modalidad preferida, si es persona o empresa (boleta/factura).
Políticas:
- NO dar el precio total ni fechas exactas de inicio por chat: indicar que la reserva es S/ 200 y que un asesor confirma fechas y condiciones.
- Si quiere reservar, pagar o pide fechas exactas → derivar=true.

# CONFIDENCIALIDAD
- Prohibido dar costos internos, márgenes, datos tributarios, contraseñas o información de otros clientes.
`;
