require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const app = express();

// إعداد تطبيق Express
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_key',
    resave: false,
    saveUninitialized: false
}));

// إعداد بوت ديسكورد باستخدام discord.js
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', () => {
    console.log(`🤖 Discord Bot logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN);

// 1. الصفحة الرئيسية
app.get('/', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    res.render('index');
});

// 2. توجيه تسجيل الدخول عبر Discord OAuth2
app.get('/auth/discord', (req, res) => {
    const clientId = process.env.CLIENT_ID;
    const redirectUri = process.env.CLIENT_REDIRECT_URI;

    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});

// 3. استقبال البيانات من ديسكورد (Callback)
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.CLIENT_REDIRECT_URI,
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        req.session.user = userResponse.data;
        res.redirect('/dashboard');
    } catch (error) {
        console.error('Error during Discord auth:', error.response?.data || error.message);
        res.redirect('/');
    }
});

// 4. لوحة التحكم
app.get('/dashboard', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }
    res.render('dashboard', { user: req.session.user });
});

// 5. استقبال إجابات التقديم وإرسالها مع الأزرار والرسالة الخاصة
app.post('/submit-application', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).send('يجب تسجيل الدخول أولاً');
    }

    const user = req.session.user;
    const answers = req.body;
    const channelId = process.env.PENDING_CHANNEL_ID;

    try {
        const targetChannel = await client.channels.fetch(channelId);
        if (!targetChannel) {
            console.error('❌ لم يتم العثور على الروم! تأكد من آيدي الروم في ملف .env');
            return res.redirect('/dashboard?error=channel_not_found');
        }

        const embed = new EmbedBuilder()
            .setTitle("🔥 تقديم جديد على إدارة ديسكورد")
            .setColor(16733952)
            .addFields(
                { name: "👤 المتقدم", value: `${user.username} (ID: \`${user.id}\`)`, inline: false },
                { name: "1. الاسم والعمر", value: answers.q1 || "-", inline: false },
                { name: "2. سبب التقديم", value: answers.q2 || "-", inline: false },
                { name: "3. الهدف في السيرفر", value: answers.q3 || "-", inline: false },
                { name: "4. ما الذي ستقدمه", value: answers.q4 || "-", inline: false },
                { name: "5. الخبرات السابقة", value: answers.q5 || "-", inline: false },
                { name: "6. التعامل مع Spam", value: answers.q6 || "-", inline: false },
                { name: "7. التعامل مع السب", value: answers.q7 || "-", inline: false },
                { name: "8. انتحال الشخصية", value: answers.q8 || "-", inline: false },
                { name: "9. الإعلانات الخارجية", value: answers.q9 || "-", inline: false },
                { name: "10. التهديد والابتزاز", value: answers.q10 || "-", inline: false }
            )
            .setTimestamp();

        // إنشاء أزرار القبول والرفض
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('accept_app')
                    .setLabel('قبول ✅')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('reject_app')
                    .setLabel('رفض ❌')
                    .setStyle(ButtonStyle.Danger)
            );

        const sentMessage = await targetChannel.send({ embeds: [embed], components: [row] });

        // استقبال ضغطات الأزرار وإرسال الرسالة الخاصة للمتقدم
        const collector = sentMessage.createMessageComponentCollector({ time: 7 * 24 * 60 * 60 * 1000 });

        collector.on('collect', async i => {
            if (!i.member.permissions.has('ManageGuild')) {
                return i.reply({ content: '❌ ليس لديك صلاحية لاتخاذ قرار على التقديم!', ephemeral: true });
            }

            // استخراج آيدي المتقدم من الـ Embed مباشرة
            const applicantField = embed.data.fields[0].value;
            const matchId = applicantField.match(/`(\d+)`/);
            const applicantId = matchId ? matchId[1] : null;

            try {
                const applicantUser = applicantId ? await client.users.fetch(applicantId) : null;

                if (i.customId === 'accept_app') {
                    embed.setColor(5763719); // أخضر
                    embed.addFields({ name: "📌 الحالة", value: `تم **قبول** التقديم بواسطة ${i.user.tag}`, inline: false });
                    await i.update({ embeds: [embed], components: [] });

                    // إرسال رسالة خاصة للمتقدم بالقبول
                    if (applicantUser) {
                        await applicantUser.send('🎉 مبروك! تم قبول تقديمك على إدارة ديسكورد في Arab Camp. افتح تذكرة لاستلام رتبتك.');
                    }
                } else if (i.customId === 'reject_app') {
                    embed.setColor(15548997); // أحمر
                    embed.addFields({ name: "📌 الحالة", value: `تم **رفض** التقديم بواسطة ${i.user.tag}`, inline: false });
                    await i.update({ embeds: [embed], components: [] });

                    // إرسال رسالة خاصة للمتقدم بالرفض
                    if (applicantUser) {
                        await applicantUser.send('❌ نأسف لك، تم رفض تقديمك على إدارة ديسكورد في Arab Camp هذه المرة. خيرها في غيرها!');
                    }
                }
            } catch (err) {
                console.error('❌ خطأ أثناء إرسال الرسالة الخاصة للمتقدم:', err.message);
            }
        });

        console.log('✅ تم إرسال التقديم مع الأزرار بنجاح إلى ديسكورد!');
        res.redirect('/dashboard?success=true');
    } catch (error) {
        console.error('❌ خطأ أثناء إرسال التقديم عبر البوت:', error.message);
        res.redirect('/dashboard?error=true');
    }
});

// 6. تسجيل الخروج
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});